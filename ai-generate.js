// FR-12: 교안 범위로 객관식 5문제를 서버에서 학교 AI로 만든다(docs/exam-workspace-ui.md, docs/ai-question-quality.md 참고).
// 학생은 개인 AI·키·MCP가 필요 없다. 키는 서버 환경 변수 KOOKMIN_KEY로만 읽고 응답·로그에 넣지 않는다.
// 생성 뒤 같은 모델에게 정답·해설을 숨기고 다시 풀게 하는 "풀이 검토"와 "해설 검토"를 거친 문항만 응답에 넣는다.
// 같은 모델을 다시 부르는 것이므로 독립 검증이 아니다. 전체 요청은 호출 수·시간 상한 안에서만 돈다.
const crypto = require('crypto');

const MAX_PAGES = 20;
const MAX_CHARS = 40000;
const COUNT = 5;
const FIRST_ASK = COUNT + 2;
const MAX_ROUNDS = 2;
const MIN_CALL_MS = 5000;
const SIMILAR = 0.6;
const REVIEW_METHOD = 'same-model-blind-solve';
const TYPES = ['정의', '비교', '적용'];

// 같은 내용의 동시 요청은 학교 AI를 한 번만 부른다(같은 서버 인스턴스 안).
const inflight = new Map();

const squash = (s) => String(s || '').replace(/\s+/g, '');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// 테스트에서 환경 변수를 바꿀 수 있게 호출 때마다 읽는다.
function cfg() {
  return {
    base: process.env.KOOKMIN_BASE_URL || 'https://ai.cs.kookmin.ac.kr',
    model: process.env.KOOKMIN_MODEL || 'claude-sonnet-5',
    callTimeout: num(process.env.KOOKMIN_CALL_TIMEOUT_MS, 55000),
    deadline: num(process.env.GENERATE_DEADLINE_MS, 110000),
    maxCalls: num(process.env.GENERATE_MAX_CALLS, 6),
  };
}

function fail(status, error, message, extra = {}) {
  const err = new Error(message);
  Object.assign(err, { status, body: { ok: false, error, message, ...extra } });
  return err;
}

function readInput(body) {
  const pages = Array.isArray(body && body.pages) ? body.pages : null;
  if (!pages || pages.length === 0) throw fail(400, 'invalid_input', '문제를 만들 쪽을 골라 주세요');
  if (pages.length > MAX_PAGES) throw fail(400, 'invalid_input', `한 번에 ${MAX_PAGES}쪽까지 고를 수 있어요. 범위를 줄여 주세요`);
  const clean = pages.map((p) => ({ page: Number(p && p.page), text: String((p && p.text) || '') }))
    .filter((p) => Number.isInteger(p.page) && p.page > 0);
  const total = clean.reduce((n, p) => n + p.text.length, 0);
  if (squash(clean.map((p) => p.text).join('')).length < 200) throw fail(400, 'invalid_input', '고른 범위에 글자가 너무 적어요. 다른 쪽을 골라 주세요');
  if (total > MAX_CHARS) throw fail(400, 'invalid_input', '고른 범위의 글자가 너무 많아요. 쪽 범위를 줄여 주세요');
  return { title: norm(body.title).slice(0, 120) || '교안', pages: clean };
}

// ===== 요청 하나의 호출·시간 예산 =====
function budget() {
  const c = cfg();
  const start = Date.now();
  const b = {
    c, calls: 0,
    elapsed: () => Date.now() - start,
    remaining: () => c.deadline - (Date.now() - start),
  };
  b.canCall = () => b.calls < c.maxCalls && b.remaining() >= MIN_CALL_MS;
  b.stopReason = () => (b.calls >= c.maxCalls ? '호출 횟수 제한' : '시간 제한');
  return b;
}

// ===== 프롬프트 =====
const sourceBlock = (pages) => pages.map((p) => `<page number="${p.page}">\n${p.text}\n</page>`).join('\n');

function mix(want) {
  const compare = Math.floor((want * 2) / 7);
  return { define: want - compare * 2, compare, apply: compare };
}

function prompt(title, pages, want, avoid) {
  const m = mix(want);
  return [
    `아래는 대학 강의 교안 "${title}"의 일부다. 이 내용만 근거로 시험 대비 객관식 문제 ${want}개를 만들어라.`,
    '순서:',
    '1) 고른 범위에서 서로 다른 핵심 개념을 먼저 뽑는다(교안에 적힌 것만).',
    '2) 개념마다 문제 1개를 배정한다. 같은 개념을 두 번 묻지 않는다.',
    `3) 유형을 섞는다. 정의: 용어·성질을 묻는다. 비교: 교안에 함께 설명된 두 개념의 차이를 묻는다. 적용: 교안에 적힌 규칙·절차·예시를 그대로 적용하면 답이 정해지는 상황을 묻는다. 목표는 정의 ${m.define}·비교 ${m.compare}·적용 ${m.apply}개이며, 교안에 비교·적용의 근거가 없으면 정의로 대신한다.`,
    '규칙:',
    '- 문제마다 선택지 정확히 4개, 정답 1개. 오답도 그럴듯하되 교안 기준으로 분명히 틀려야 한다. 보기끼리 같은 뜻이거나 한 보기가 다른 보기를 포함하면 안 된다(예: "스택"과 "LIFO 스택"을 함께 넣지 않는다).',
    '- explanation은 정답 보기를 그대로 언급하고 왜 맞는지 교안 내용으로 설명한다.',
    '- evidence.quote에는 정답의 근거가 되는 문장을 교안에서 글자 그대로 복사해 넣는다(10자 이상, 고치거나 요약하지 않는다). evidence.page는 그 문장이 있는 쪽 번호다. 문제마다 다른 문장을 쓴다.',
    '- 교안에 없는 지식으로 묻지 않는다. 억지로 어렵게 만들거나 계산을 요구하지 않는다.',
    avoid.length ? `- 다음 문제와 겹치지 않게 한다: ${avoid.map((b) => `"${b}"`).join(', ')}` : '',
    '출력은 JSON 하나만. 설명 문장이나 코드 블록 표시 없이:',
    '{"questions":[{"concept":"개념 이름","type":"정의","body":"문제","choices":["보기1","보기2","보기3","보기4"],"answer_index":0,"explanation":"해설","evidence":{"page":1,"quote":"교안 원문 문장"}}]}',
    '',
    sourceBlock(pages),
  ].filter(Boolean).join('\n');
}

const questionBlock = (items, withExplanation) => items.map((it) => [
  `[${it.cid}] ${it.body}`,
  ...it.choices.map((c, i) => `  ${i}) ${c}`),
  withExplanation ? `  해설: ${it.explanation}` : '',
].filter(Boolean).join('\n')).join('\n\n');

// 풀이 검토: 생성된 정답·해설·근거를 넣지 않는다.
function solvePrompt(items, ctx) {
  return [
    `아래는 대학 강의 교안 "${ctx.title}"의 일부와 그 범위에서 만든 객관식 문제다. 교안만 근거로 각 문제를 풀어라.`,
    '규칙:',
    '- 교안에 없는 지식으로 판단하지 않는다. 교안에서 답을 정할 수 없으면 single_answer를 false로 둔다.',
    '- 보기마다 verdict를 적는다. correct: 교안 기준 정답, wrong: 교안 기준 틀림, unsure: 교안으로 판단 불가. correct가 둘 이상이거나 하나도 없으면 single_answer는 false다.',
    '- evidence_quote에는 정답의 근거 문장을 교안에서 글자 그대로 복사한다(10자 이상).',
    '출력은 JSON 하나만. 설명 문장이나 코드 블록 표시 없이:',
    '{"results":[{"id":"c1","single_answer":true,"chosen":0,"evidence_quote":"교안 원문 문장","per_choice":[{"index":0,"verdict":"correct","reason":"짧은 이유"},{"index":1,"verdict":"wrong","reason":"짧은 이유"},{"index":2,"verdict":"wrong","reason":"짧은 이유"},{"index":3,"verdict":"wrong","reason":"짧은 이유"}]}]}',
    '',
    '문제:',
    questionBlock(items, false),
    '',
    sourceBlock(ctx.pages),
  ].join('\n');
}

// 해설 검토: 정답 번호는 넣지 않는다. 해설이 어느 보기를 정답이라 하는지 묻는다.
function auditPrompt(items, ctx) {
  return [
    `아래는 대학 강의 교안 "${ctx.title}"의 일부와 그 범위에서 만든 객관식 문제·보기·해설이다. 각 해설이 정답으로 설명하는 보기 번호를 찾고, 해설 내용이 교안과 맞는지 판단하라.`,
    '규칙:',
    '- explanation_answer_index: 해설이 정답이라고 설명하는 보기 번호(0~3). 어느 보기인지 알 수 없거나 둘 이상이면 -1.',
    '- consistent: 해설의 설명이 교안 내용과 어긋나지 않으면 true, 어긋나거나 교안에 없는 주장이면 false.',
    '출력은 JSON 하나만. 설명 문장이나 코드 블록 표시 없이:',
    '{"results":[{"id":"c1","explanation_answer_index":0,"consistent":true,"reason":"짧은 이유"}]}',
    '',
    '문제:',
    questionBlock(items, true),
    '',
    sourceBlock(ctx.pages),
  ].join('\n');
}

// ===== 학교 AI 호출 =====
async function callAI(text, b, maxTokens) {
  const key = process.env.KOOKMIN_KEY;
  if (!key) throw fail(503, 'ai_not_configured', 'AI 연결이 아직 안 됐어요. 운영자가 서버 설정을 마치면 다시 시도해 주세요');
  b.calls += 1;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Math.min(b.c.callTimeout, b.remaining())));
  try {
    const r = await fetch(`${b.c.base}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: b.c.model, max_tokens: maxTokens, messages: [{ role: 'user', content: text }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = (data && data.error && data.error.message) || `HTTP ${r.status}`;
      console.error('[ai-generate] 학교 AI 오류', r.status, String(reason).slice(0, 200));
      throw fail(502, 'ai_failed', r.status === 403 ? '학교 AI 크레딧이 부족해요. 운영자에게 알려 주세요' : '학교 AI가 응답하지 못했어요. 잠시 후 다시 시도해 주세요');
    }
    return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  } catch (e) {
    if (e.name === 'AbortError') throw fail(504, 'ai_timeout', '문제 만들기가 너무 오래 걸렸어요. 범위를 줄여 다시 시도해 주세요');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// ===== 형식·근거·중복 검사(비용 없음) =====
function newSeen() {
  return { bodies: new Set(), grams: [], quotes: new Set(), choiceSets: new Set(), concepts: new Set() };
}
function cloneSeen(s) {
  return { bodies: new Set(s.bodies), grams: [...s.grams], quotes: new Set(s.quotes), choiceSets: new Set(s.choiceSets), concepts: new Set(s.concepts) };
}
function bigrams(s) {
  const t = squash(s);
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n / (a.size + b.size - n);
}
function remember(seen, q) {
  seen.bodies.add(squash(q.body));
  seen.quotes.add(squash(q.evidence.quote));
  seen.choiceSets.add(q.choices.map(squash).sort().join('|'));
  seen.grams.push(bigrams(q.body));
  if (q.concept) seen.concepts.add(squash(q.concept));
}

// 통과하면 정리된 문항(seen에 기록), 아니면 거절 사유 문자열.
function check(q, pageText, seen) {
  if (seen instanceof Set) seen = Object.assign(newSeen(), { bodies: seen }); // 이전 호출 방식 호환
  if (!q || typeof q !== 'object') return '형식 오류';
  const body = norm(q.body);
  if (body.length < 8) return '문제 문장 없음';
  if (seen.bodies.has(squash(body))) return '중복 문제';
  const choices = Array.isArray(q.choices) ? q.choices.map(norm) : [];
  if (choices.length !== 4 || choices.some((c) => !c)) return '선택지 4개 아님';
  const sq = choices.map(squash);
  if (new Set(sq).size !== 4) return '선택지 중복';
  if (sq.some((a, i) => a.length >= 2 && sq.some((b, j) => i !== j && b.includes(a)))) return '보기가 서로 포함';
  const answerIndex = Number(q.answer_index);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return '정답 번호 오류';
  const explanation = norm(q.explanation);
  if (explanation.length < 5) return '해설 없음';
  const page = Number(q.evidence && q.evidence.page);
  const quote = norm(q.evidence && q.evidence.quote);
  if (!pageText.has(page)) return '근거 쪽이 범위 밖';
  if (squash(quote).length < 10 || !pageText.get(page).includes(squash(quote))) return '근거 문장이 교안에 없음';
  if (seen.quotes.has(squash(quote))) return '같은 근거 반복';
  if (seen.choiceSets.has([...sq].sort().join('|'))) return '같은 보기 반복';
  const grams = bigrams(body);
  if (seen.grams.some((g) => jaccard(g, grams) >= SIMILAR)) return '비슷한 문제';
  const concept = norm(q.concept).slice(0, 60) || null;
  if (concept && seen.concepts.has(squash(concept))) return '같은 개념 반복';
  const type = TYPES.includes(norm(q.type)) ? norm(q.type) : null;
  const item = { body, choices, answerIndex, explanation, evidence: { page, quote }, concept, type };
  remember(seen, item);
  return item;
}

// ===== 검토 판정 =====
function verdictMap(per) {
  const out = ['', '', '', ''];
  per.forEach((p, pos) => {
    if (!p || typeof p !== 'object') return;
    const i = Number.isInteger(Number(p.index)) ? Number(p.index) : pos;
    if (i >= 0 && i < 4) out[i] = String(p.verdict || '').toLowerCase();
  });
  return out;
}

function judgeSolve(item, r, pageText) {
  if (!r) return '검토 누락';
  const chosen = Number(r.chosen);
  const per = Array.isArray(r.per_choice) ? r.per_choice : [];
  if (!Number.isInteger(chosen) || chosen < 0 || chosen > 3 || per.length !== 4) return '검토 응답 오류';
  if (r.single_answer !== true) return '검토: 단일 정답 아님';
  if (chosen !== item.answerIndex) return '검토 정답 불일치';
  const v = verdictMap(per);
  for (let i = 0; i < 4; i++) if (i !== item.answerIndex && v[i] === 'correct') return '검토: 복수 정답';
  if (v[item.answerIndex] !== 'correct') return '검토: 정답 확신 부족';
  const eq = squash(r.evidence_quote);
  if (eq.length < 10 || ![...pageText.values()].some((t) => t.includes(eq))) return '검토 근거 부족';
  return null;
}

function judgeAudit(item, r) {
  if (!r) return '해설 검토 누락';
  const idx = Number(r.explanation_answer_index);
  if (!Number.isInteger(idx) || idx < -1 || idx > 3) return '검토 응답 오류';
  if (idx !== item.answerIndex) return '해설이 다른 보기를 가리킴';
  if (r.consistent !== true) return '해설이 교안과 어긋남';
  return null;
}

// 검토 호출 한 단계. 형식 오류면 같은 후보로 한 번 더 부른다. 예산이 없으면 null.
async function reviewStep(items, ctx, b, rejected, makePrompt, judge, maxTokens) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!b.canCall()) return null;
    const parsed = parseJson(await callAI(makePrompt(items, ctx), b, maxTokens));
    const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
    if (!results) continue;
    const byId = new Map(results.filter((r) => r && typeof r === 'object').map((r) => [String(r.id), r]));
    const kept = [];
    for (const it of items) {
      const reason = judge(it, byId.get(it.cid));
      if (reason) rejected.push(reason); else kept.push(it);
    }
    return kept;
  }
  items.forEach(() => rejected.push('검토 응답 형식 오류'));
  return [];
}

async function review(candidates, ctx, b, rejected) {
  const solved = await reviewStep(candidates, ctx, b, rejected, solvePrompt, (it, r) => judgeSolve(it, r, ctx.pageText), 2500);
  if (solved === null || solved.length === 0) return solved;
  return reviewStep(solved, ctx, b, rejected, auditPrompt, judgeAudit, 1500);
}

// ===== 전체 흐름 =====
async function generate({ title, pages }) {
  const b = budget();
  const pageText = new Map(pages.map((p) => [p.page, squash(p.text)]));
  const ctx = { title, pages, pageText };
  const seen = newSeen();
  const valid = [];
  const rejected = [];
  let reviewed = 0;
  let cid = 0;
  let stop = null;
  for (let round = 0; round < MAX_ROUNDS && valid.length < COUNT; round++) {
    if (!b.canCall()) { stop = b.stopReason(); break; }
    const ask = round === 0 ? FIRST_ASK : COUNT - valid.length + 2;
    const parsed = parseJson(await callAI(prompt(title, pages, ask, valid.map((q) => q.body)), b, 4000));
    const list = parsed && Array.isArray(parsed.questions) ? parsed.questions : null;
    if (!list) { rejected.push('생성 응답 형식 오류'); continue; }
    const batchSeen = cloneSeen(seen);
    const candidates = [];
    for (const q of list) {
      const r = check(q, pageText, batchSeen);
      if (typeof r === 'string') rejected.push(r);
      else candidates.push({ ...r, cid: `c${++cid}` });
    }
    if (!candidates.length) continue;
    reviewed += candidates.length;
    const kept = await review(candidates, ctx, b, rejected);
    if (kept === null) { stop = b.stopReason(); break; }
    for (const q of kept) {
      if (valid.length >= COUNT) break;
      const { cid: _cid, ...item } = q;
      valid.push(item);
      remember(seen, item);
    }
  }
  if (!stop && valid.length < COUNT && !b.canCall()) stop = b.stopReason();
  if (stop) rejected.push(stop);
  console.log(`[ai-generate] calls=${b.calls} elapsed=${b.elapsed()}ms valid=${valid.length} rejected=${rejected.length}`);
  if (valid.length < COUNT) {
    throw fail(422, 'not_enough_valid', `검사를 통과한 문제가 ${valid.length}개뿐이에요. 다시 시도하거나 범위를 바꿔 주세요`, {
      validCount: valid.length,
      rejectedReasons: rejected.slice(0, 10),
      calls: b.calls,
    });
  }
  return {
    ok: true,
    source: 'school-ai',
    model: b.c.model,
    generatedAt: new Date().toISOString(),
    questions: valid.map((q, i) => ({ id: `q${i + 1}`, ...q })),
    rejectedCount: rejected.length,
    review: { method: REVIEW_METHOD, model: b.c.model, reviewed, calls: b.calls, elapsedMs: b.elapsed() },
  };
}

module.exports = function registerAiGenerate(app) {
  app.post('/api/generate', async (req, res) => {
    try {
      const input = readInput(req.body);
      const key = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if (!inflight.has(key)) {
        inflight.set(key, generate(input).finally(() => inflight.delete(key)));
      }
      res.json(await inflight.get(key));
    } catch (e) {
      if (e.status) return res.status(e.status).json(e.body);
      console.error('[ai-generate] 처리 오류', e.message);
      res.status(500).json({ ok: false, error: 'server_error', message: '문제를 만들지 못했어요. 다시 시도해 주세요' });
    }
  });
};

module.exports.check = check;
module.exports.squash = squash;
module.exports.newSeen = newSeen;
module.exports.readInput = readInput;
module.exports.generate = generate;
module.exports.REVIEW_METHOD = REVIEW_METHOD;
