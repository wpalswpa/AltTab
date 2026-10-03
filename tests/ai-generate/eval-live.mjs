// 고정 평가 자료(fixtures/*.json)로 생성→검토 흐름을 실제 학교 AI에 돌리는 도구.
// 기본은 --estimate(비용 추정만). --run은 서버 환경의 KOOKMIN_KEY와 --max-usd 승인액이 있을 때만 실제 호출한다.
// 결과는 eval-results/<시각>.json과 사람 평가용 CSV로 남긴다. 사람이 판정하기 전에는 정답 정확성을 수치로 쓰지 않는다.
//
//   node tests/ai-generate/eval-live.mjs --estimate [--set eval|tuning|all] [--repeat 2]
//   node tests/ai-generate/eval-live.mjs --run --max-usd 1 [--set eval] [--repeat 2]
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { generate } = require('../../ai-generate.js');
const budget = JSON.parse(readFileSync(path.join(here, '../../docs/proposals/ai-budget.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const set = opt('--set', 'eval');
const repeat = Math.max(1, Number(opt('--repeat', 1)) || 1);
const maxUsd = Number(opt('--max-usd', NaN));

const fixtures = readdirSync(path.join(here, 'fixtures')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(here, 'fixtures', f), 'utf8')))
  .filter((f) => set === 'all' || f.set === set);
if (!fixtures.length) { console.error(`--set ${set}에 해당하는 자료가 없다`); process.exit(2); }

// 추정식(실측 전 대략값): 한국어 글자 1.5자 ≈ 토큰 1개. 호출은 생성·풀이 검토·해설 검토 3회가 기본, 최대 6회.
const CHARS_PER_TOKEN = 1.5;
const PROMPT_CHARS = { generate: 900, solve: 1400, audit: 900 };
const QUESTION_BLOCK_CHARS = 7 * 160;
const OUT_TOKENS = { generate: 1800, solve: 900, audit: 400 };
const inPrice = budget.input_usd_per_million_tokens / 1e6;
const outPrice = budget.output_usd_per_million_tokens / 1e6;

function estimate(f) {
  const chars = f.pages.reduce((n, p) => n + p.text.length, 0);
  const inTok = ((chars + PROMPT_CHARS.generate) + (chars + QUESTION_BLOCK_CHARS + PROMPT_CHARS.solve) + (chars + QUESTION_BLOCK_CHARS + 300 + PROMPT_CHARS.audit)) / CHARS_PER_TOKEN;
  const outTok = OUT_TOKENS.generate + OUT_TOKENS.solve + OUT_TOKENS.audit;
  const usd = inTok * inPrice + outTok * outPrice;
  return { chars, inTok: Math.round(inTok), outTok, usd, worstUsd: usd * 2 };
}

const rows = fixtures.map((f) => ({ fixture: f.id, set: f.set, ...estimate(f) }));
const totalTypical = rows.reduce((n, r) => n + r.usd, 0) * repeat;
const totalWorst = rows.reduce((n, r) => n + r.worstUsd, 0) * repeat;
console.log(`단가: 입력 ${budget.input_usd_per_million_tokens} USD/M, 출력 ${budget.output_usd_per_million_tokens} USD/M (${budget.pricing_source}, ${budget.pricing_checked_on} 확인)`);
console.table(rows.map((r) => ({ 자료: r.fixture, 구분: r.set, 글자: r.chars, '입력토큰(추정)': r.inTok, '출력토큰(추정)': r.outTok, 'USD/요청(3호출)': r.usd.toFixed(4), 'USD 최악(6호출)': r.worstUsd.toFixed(4) })));
console.log(`요청 ${rows.length}건 × 반복 ${repeat} = ${rows.length * repeat}건, 호출 ${rows.length * repeat * 3}~${rows.length * repeat * 6}회, 문항 최대 ${rows.length * repeat * 5}개`);
console.log(`비용 추정: 보통 ${totalTypical.toFixed(3)} USD, 최악 ${totalWorst.toFixed(3)} USD (추정식이며 실측 전)`);

if (!flag('--run')) { console.log('\n실제 호출 없음(--estimate). 실행하려면 --run --max-usd <승인액> 과 서버 환경의 KOOKMIN_KEY가 필요하다.'); process.exit(0); }
if (!process.env.KOOKMIN_KEY) { console.error('KOOKMIN_KEY가 없어 실행하지 않는다.'); process.exit(2); }
if (!Number.isFinite(maxUsd) || maxUsd <= 0) { console.error('--max-usd <승인액> 이 없어 실행하지 않는다.'); process.exit(2); }
if (totalWorst > maxUsd) { console.error(`최악 추정 ${totalWorst.toFixed(3)} USD가 승인액 ${maxUsd} USD를 넘어 실행하지 않는다. --repeat나 --set을 줄여라.`); process.exit(2); }

const outDir = path.join(here, 'eval-results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runs = [];
for (let r = 1; r <= repeat; r++) {
  for (const f of fixtures) {
    const started = Date.now();
    const rec = { run: r, fixture: f.id, set: f.set, title: f.title, startedAt: new Date(started).toISOString() };
    try {
      const out = await generate({ title: f.title, pages: f.pages });
      Object.assign(rec, { ok: true, elapsedMs: Date.now() - started, model: out.model, review: out.review, rejectedCount: out.rejectedCount, questions: out.questions });
    } catch (e) {
      Object.assign(rec, { ok: false, elapsedMs: Date.now() - started, status: e.status || 500, body: e.body || { message: e.message } });
    }
    runs.push(rec);
    console.log(`${rec.ok ? '성공' : `실패 ${rec.status} ${rec.body && rec.body.error}`} · ${f.id} #${r} · ${rec.elapsedMs}ms · 호출 ${(rec.review && rec.review.calls) || (rec.body && rec.body.calls) || '?'}회`);
  }
}

const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const header = ['실행', '자료', '문항', '개념', '유형', '문제', '보기0', '보기1', '보기2', '보기3', '생성정답', '해설', '근거쪽', '근거문장', '사람_정답맞음(Y/N)', '사람_단일정답(Y/N)', '사람_근거충분(Y/N)', '사람_해설맞음(Y/N)', '사람_교안범위안(Y/N)', '사람_중복(Y/N)', '비고'];
const lines = [header.map(csvCell).join(',')];
for (const rec of runs) {
  for (const x of rec.questions || []) {
    lines.push([rec.run, rec.fixture, x.id, x.concept, x.type, x.body, ...x.choices, x.answerIndex, x.explanation, x.evidence.page, x.evidence.quote, '', '', '', '', '', '', ''].map(csvCell).join(','));
  }
}
const jsonPath = path.join(outDir, `${stamp}.json`);
const csvPath = path.join(outDir, `${stamp}-human-review.csv`);
writeFileSync(jsonPath, JSON.stringify({ stamp, set, repeat, estimate: { typicalUsd: totalTypical, worstUsd: totalWorst }, runs }, null, 2));
writeFileSync(csvPath, `﻿${lines.join('\n')}`);

const okRuns = runs.filter((r) => r.ok);
const questions = okRuns.flatMap((r) => r.questions);
const count = (arr, key) => arr.reduce((m, x) => { const k = x[key] || '(없음)'; m[k] = (m[k] || 0) + 1; return m; }, {});
console.log('\n요약(사람 판정 전 — 정답 정확성 수치가 아니다)');
console.log(`요청 ${runs.length}건, 성공 ${okRuns.length}건, 실패 ${runs.length - okRuns.length}건 ${JSON.stringify(count(runs.filter((r) => !r.ok).map((r) => ({ e: `${r.status} ${r.body && r.body.error}` })), 'e'))}`);
console.log(`확보 문항 ${questions.length}개(목표 30~50), 호출 합계 ${runs.reduce((n, r) => n + ((r.review && r.review.calls) || (r.body && r.body.calls) || 0), 0)}회, 검토 등에서 거절 ${okRuns.reduce((n, r) => n + r.rejectedCount, 0)}건`);
console.log(`걸린 시간: 평균 ${Math.round(runs.reduce((n, r) => n + r.elapsedMs, 0) / runs.length)}ms, 최대 ${Math.max(...runs.map((r) => r.elapsedMs))}ms`);
console.log(`유형 분포 ${JSON.stringify(count(questions, 'type'))}, 개념 수 ${new Set(questions.map((x) => x.concept)).size}`);
console.log(`저장: ${jsonPath}\n사람 평가: ${csvPath} 의 '사람_' 칸을 채운 뒤 docs/ai-question-quality.md 8절에 분모와 함께 적는다.`);
