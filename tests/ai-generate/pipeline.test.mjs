// 생성 → 글자 검사 → 풀이 검토 → 해설 검토 흐름을 가짜 학교 AI 서버로 확인한다(비용 없음).
// 가짜 응답으로 검사 흐름을 확인하는 것이지 모델 정확도를 재는 것이 아니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { generate, readInput, squash, REVIEW_METHOD } = require('../../ai-generate.js');

// ----- 고정 교안(팀 작성) -----
const S = [
  '스택은 가장 나중에 들어온 데이터를 가장 먼저 꺼내는 자료구조다.',
  '큐는 먼저 들어온 데이터를 먼저 꺼내는 자료구조다.',
  '배열은 연속된 메모리에 원소를 저장하므로 인덱스로 원소 하나에 바로 접근한다.',
  '연결 리스트는 각 노드가 다음 노드의 주소를 가지며 원소를 찾으려면 처음부터 차례로 따라간다.',
  '트리는 사이클이 없는 연결 그래프이며 정점이 n개이면 간선은 n-1개다.',
  '너비 우선 탐색은 시작 정점에서 가까운 정점부터 차례로 방문한다.',
  '해시 테이블은 키를 해시 함수로 바꿔 저장 위치를 정한다.',
];
const PAGES = [{ page: 1, text: S.slice(0, 4).join(' ') }, { page: 2, text: S.slice(4).join(' ') }];
const INPUT = { title: '자료구조 3주차', pages: PAGES };
const q = (concept, type, body, choices, answer, page, quote) => ({ concept, type, body, choices, answer_index: answer, explanation: `정답은 ${choices[answer]}이다. 교안에 "${quote}"라고 적혀 있다.`, evidence: { page, quote } });
const GOOD = [
  q('스택', '정의', '가장 나중에 들어온 데이터를 가장 먼저 꺼내는 자료구조는 무엇인가?', ['큐', '스택', '힙', '배열'], 1, 1, S[0]),
  q('큐', '비교', '스택과 달리 먼저 들어온 데이터를 먼저 꺼내는 자료구조는?', ['트리', '그래프', '큐', '해시 테이블'], 2, 1, S[1]),
  q('배열', '적용', '인덱스 3번 원소에 바로 접근할 수 있는 저장 방식은?', ['연결 리스트', '배열', '스택', '큐'], 1, 1, S[2]),
  q('연결 리스트', '정의', '각 노드가 다음 노드의 주소를 가지는 자료구조는?', ['배열', '해시 테이블', '연결 리스트', '트리'], 2, 1, S[3]),
  q('트리', '적용', '정점이 10개인 트리의 간선 수는?', ['8개', '9개', '10개', '11개'], 1, 2, S[4]),
  q('너비 우선 탐색', '정의', '시작 정점에서 가까운 정점부터 차례로 방문하는 탐색은?', ['깊이 우선 탐색', '너비 우선 탐색', '이진 탐색', '선형 탐색'], 1, 2, S[5]),
  q('해시 테이블', '정의', '키를 해시 함수로 바꿔 저장 위치를 정하는 자료구조는?', ['스택', '큐', '트리', '해시 테이블'], 3, 2, S[6]),
];
const byBody = new Map(GOOD.map((g) => [g.body, g]));

// ----- 가짜 학교 AI -----
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const stage = (p) => (p.includes('"questions":[') ? 'generate' : p.includes('"single_answer"') ? 'solve' : p.includes('"explanation_answer_index"') ? 'audit' : 'unknown');
const listed = (p) => [...p.matchAll(/^\[(c\d+)\] (.+)$/gm)].map((m) => ({ id: m[1], body: m[2] }));
const fnOr = (patch) => (typeof patch === 'function' ? patch : () => ({}));
const solveOk = (p, patch) => text({ results: listed(p).map(({ id, body }) => {
  const g = byBody.get(body);
  return { id, single_answer: true, chosen: g.answer_index, evidence_quote: g.evidence.quote, per_choice: [0, 1, 2, 3].map((i) => ({ index: i, verdict: i === g.answer_index ? 'correct' : 'wrong', reason: '교안' })), ...fnOr(patch)(id, body, g) };
}) });
const auditOk = (p, patch) => text({ results: listed(p).map(({ id, body }) => ({ id, explanation_answer_index: byBody.get(body).answer_index, consistent: true, reason: '해설이 정답 보기를 설명', ...fnOr(patch)(id, body) })) });

// handler(stage, prompt, n) → { status?, body?, delayMs? } ; 기록은 calls에 남긴다.
async function withFakeAI(handler, fn, env = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const p = body.messages[0].content;
      const st = stage(p);
      calls.push({ stage: st, prompt: p, max_tokens: body.max_tokens, auth: req.headers.authorization });
      const r = handler(st, p, calls.length) || {};
      setTimeout(() => {
        res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body || text('')));
      }, r.delayMs || 0);
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const saved = { ...process.env };
  Object.assign(process.env, { KOOKMIN_BASE_URL: `http://127.0.0.1:${server.address().port}`, KOOKMIN_KEY: 'dummy-not-a-real-key', KOOKMIN_MODEL: 'fake-model', GENERATE_MAX_CALLS: '6', GENERATE_DEADLINE_MS: '110000', KOOKMIN_CALL_TIMEOUT_MS: '55000', ...env });
  try {
    return await fn(calls);
  } finally {
    for (const k of ['KOOKMIN_BASE_URL', 'KOOKMIN_KEY', 'KOOKMIN_MODEL', 'GENERATE_MAX_CALLS', 'GENERATE_DEADLINE_MS', 'KOOKMIN_CALL_TIMEOUT_MS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
}
const script = (gen, solve = solveOk, audit = auditOk) => (st, p, n) => ({ body: st === 'generate' ? gen(p, n) : st === 'solve' ? solve(p, n) : audit(p, n) });
const expectFail = async (fn, status, error) => {
  const e = await fn().then(() => null, (err) => err);
  assert.ok(e, '실패해야 하는데 성공했다');
  assert.equal(e.status, status, e.message);
  assert.equal(e.body.error, error);
  return e.body;
};

test('고정 교안은 입력 검사를 통과한다', () => {
  assert.ok(squash(PAGES.map((p) => p.text).join('')).length >= 200);
  assert.equal(readInput({ ...INPUT, count: 5 }).pages.length, 2);
});

test('정상: 생성 7 → 풀이 검토 → 해설 검토 → 5문항 응답 계약 유지 + review 메타', () => withFakeAI(script(() => text({ questions: GOOD })), async (calls) => {
  const out = await generate(INPUT);
  assert.equal(out.ok, true);
  assert.equal(out.source, 'school-ai');
  assert.equal(out.model, 'fake-model');
  assert.ok(out.generatedAt);
  assert.deepEqual(out.questions.map((x) => x.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
  for (const [i, x] of out.questions.entries()) {
    assert.deepEqual(Object.keys(x).sort(), ['answerIndex', 'body', 'choices', 'concept', 'evidence', 'explanation', 'id', 'type'].sort());
    assert.equal(x.choices.length, 4);
    assert.equal(x.answerIndex, GOOD[i].answer_index);
    assert.deepEqual(x.evidence, GOOD[i].evidence);
    assert.equal(x.concept, GOOD[i].concept);
    assert.equal(x.type, GOOD[i].type);
  }
  assert.equal(out.rejectedCount, 0);
  assert.deepEqual(out.review, { ...out.review, method: REVIEW_METHOD, model: 'fake-model', reviewed: 7, calls: 3 });
  assert.equal(typeof out.review.elapsedMs, 'number');
  assert.deepEqual(calls.map((c) => c.stage), ['generate', 'solve', 'audit']);
  assert.equal(calls[0].auth, 'Bearer dummy-not-a-real-key');
  // 풀이 검토에는 정답·해설·근거를 넣지 않고, 해설 검토에는 정답 번호를 넣지 않는다.
  assert.doesNotMatch(calls[1].prompt, /answer_index|해설:|정답은 /);
  assert.match(calls[2].prompt, /해설: 정답은 스택이다/);
  assert.doesNotMatch(calls[2].prompt, /"answer_index"|answerIndex/); // 필드명 explanation_answer_index는 생성 정답이 아니다
  // 생성 프롬프트는 개념 배분과 유형(정의 3·비교 2·적용 2)을 요구한다.
  assert.match(calls[0].prompt, /정의 3·비교 2·적용 2개/);
  assert.match(calls[0].prompt, /같은 개념을 두 번 묻지 않는다/);
}));

test('잘못된 정답: 풀이 검토가 다른 보기를 고르면 그 문항을 뺀다(사례 1)', () => withFakeAI(script(() => text({ questions: [{ ...GOOD[0], answer_index: 0, explanation: '정답은 큐다.' }, ...GOOD.slice(1)] })), async () => {
  const out = await generate(INPUT);
  assert.equal(out.questions.length, 5);
  assert.ok(!out.questions.some((x) => x.body === GOOD[0].body));
  assert.equal(out.rejectedCount, 1);
}));

test('복수 정답·단일 정답 아님·근거 부족·확신 부족은 422 사유로 남는다', () => withFakeAI(script(
  () => text({ questions: GOOD.slice(0, 5) }),
  (p) => solveOk(p, (id, body) => (body === GOOD[0].body ? { per_choice: [{ index: 0, verdict: 'correct' }, { index: 1, verdict: 'correct' }, { index: 2, verdict: 'wrong' }, { index: 3, verdict: 'wrong' }] }
    : body === GOOD[1].body ? { single_answer: false }
      : body === GOOD[2].body ? { evidence_quote: '교안에 없는 문장을 근거라고 적은 경우' }
        : body === GOOD[3].body ? { per_choice: [0, 1, 2, 3].map((i) => ({ index: i, verdict: 'unsure' })) } : {})),
), async (calls) => {
  const body = await expectFail(() => generate(INPUT), 422, 'not_enough_valid');
  assert.equal(body.validCount, 1);
  for (const r of ['검토: 복수 정답', '검토: 단일 정답 아님', '검토 근거 부족', '검토: 정답 확신 부족']) assert.ok(body.rejectedReasons.includes(r), r);
  assert.ok(body.rejectedReasons.includes('호출 횟수 제한'));
  assert.equal(body.calls, 3);
  assert.equal(calls.length, 3);
}, { GENERATE_MAX_CALLS: '3' }));

test('모순 해설: 해설이 다른 보기를 가리키거나 교안과 어긋나면 뺀다(사례 2)', () => withFakeAI(script(
  () => text({ questions: GOOD }),
  undefined,
  (p) => auditOk(p, (id, body) => (body === GOOD[0].body ? { explanation_answer_index: 0 } : body === GOOD[1].body ? { consistent: false } : {})),
), async () => {
  const out = await generate(INPUT);
  assert.equal(out.questions.length, 5);
  assert.ok(!out.questions.some((x) => x.body === GOOD[0].body || x.body === GOOD[1].body));
  assert.equal(out.rejectedCount, 2);
}));

test('검토 누락: 풀이·해설 검토 결과에 없는 문항은 통과시키지 않는다', () => withFakeAI(script(
  () => text({ questions: GOOD.slice(0, 5) }),
  (p) => { const r = JSON.parse(solveOk(p).content[0].text); r.results = r.results.filter((x) => x.id !== 'c1'); return text(r); },
  (p) => { const r = JSON.parse(auditOk(p).content[0].text); r.results = r.results.filter((x) => x.id !== 'c2'); return text(r); },
), async () => {
  const body = await expectFail(() => generate(INPUT), 422, 'not_enough_valid');
  assert.equal(body.validCount, 3);
  assert.ok(body.rejectedReasons.includes('검토 누락'));
  assert.ok(body.rejectedReasons.includes('해설 검토 누락'));
}, { GENERATE_MAX_CALLS: '3' }));

test('검토 JSON 오류: 한 번 더 부르고 또 실패하면 전부 거절한다', () => withFakeAI(script(() => text({ questions: GOOD }), () => text('죄송합니다, JSON이 아닙니다')), async (calls) => {
  const body = await expectFail(() => generate(INPUT), 422, 'not_enough_valid');
  assert.equal(body.validCount, 0);
  assert.ok(body.rejectedReasons.includes('검토 응답 형식 오류'));
  assert.deepEqual(calls.map((c) => c.stage), ['generate', 'solve', 'solve']);
}, { GENERATE_MAX_CALLS: '3' }));

test('검토 JSON 오류 뒤 재시도가 성공하면 통과한다', () => withFakeAI(script(() => text({ questions: GOOD }), (p, n) => (n === 2 ? text('{"results": [broken') : solveOk(p))), async (calls) => {
  const out = await generate(INPUT);
  assert.equal(out.questions.length, 5);
  assert.deepEqual(calls.map((c) => c.stage), ['generate', 'solve', 'solve', 'audit']);
  assert.equal(out.review.calls, 4);
}));

test('생성 JSON 오류: 두 라운드 모두 실패하면 422, 호출 2회', () => withFakeAI(script(() => text('```json\n{"questions": [')), async (calls) => {
  const body = await expectFail(() => generate(INPUT), 422, 'not_enough_valid');
  assert.equal(body.validCount, 0);
  assert.ok(body.rejectedReasons.includes('생성 응답 형식 오류'));
  assert.equal(calls.length, 2);
}));

test('호출 타임아웃: 호출 하나가 제한을 넘기면 504 ai_timeout', () => withFakeAI(() => ({ delayMs: 1500, body: text({ questions: GOOD }) }), async () => {
  await expectFail(() => generate(INPUT), 504, 'ai_timeout');
}, { KOOKMIN_CALL_TIMEOUT_MS: '200' }));

test('전체 제한 시간: 남은 시간이 5초 미만이면 새 호출 없이 422(시간 제한)', () => withFakeAI(() => ({ delayMs: 400, body: text({ questions: GOOD }) }), async (calls) => {
  const body = await expectFail(() => generate(INPUT), 422, 'not_enough_valid');
  assert.ok(body.rejectedReasons.includes('시간 제한'));
  assert.equal(calls.length, 1);
}, { GENERATE_DEADLINE_MS: '5300' }));

test('최대 호출 수: 상한에 닿으면 검토를 건너뛰어 통과시키지 않고 422(호출 횟수 제한)', () => withFakeAI(script(() => text({ questions: GOOD })), async (calls) => {
  const body = await expectFail(() => generate(INPUT), 422, 'not_enough_valid');
  assert.equal(body.validCount, 0);
  assert.ok(body.rejectedReasons.includes('호출 횟수 제한'));
  assert.deepEqual(calls.map((c) => c.stage), ['generate', 'solve']);
}, { GENERATE_MAX_CALLS: '2' }));

test('5문항 미달: 생성이 3개뿐이면 422에 validCount 3', () => withFakeAI(script(() => text({ questions: GOOD.slice(0, 3) })), async () => {
  const body = await expectFail(() => generate(INPUT), 422, 'not_enough_valid');
  assert.equal(body.validCount, 3);
  assert.match(body.message, /3개뿐/);
  assert.ok(!('questions' in body));
}, { GENERATE_MAX_CALLS: '3' }));

test('2라운드: 1라운드 4개면 부족분을 한 번 더 받아 5개를 채운다(호출 6회)', () => withFakeAI(script((p, n) => text({ questions: n === 1 ? GOOD.slice(0, 4) : GOOD.slice(4) })), async (calls) => {
  const out = await generate(INPUT);
  assert.equal(out.questions.length, 5);
  assert.equal(out.review.calls, 6);
  assert.deepEqual(calls.map((c) => c.stage), ['generate', 'solve', 'audit', 'generate', 'solve', 'audit']);
  assert.match(calls[3].prompt, /객관식 문제 3개/);
  assert.ok(calls[3].prompt.includes(`겹치지 않게 한다: "${GOOD[0].body}"`), '2라운드 프롬프트에 통과 문항 회피 목록이 없다');
}));

test('글자 검사 거절(보기 포함·같은 근거)은 검토 호출 전에 걸러진다', () => withFakeAI(script(() => text({ questions: [{ ...GOOD[0], choices: ['큐', '스택', 'LIFO 스택', '배열'] }, { ...GOOD[1], evidence: GOOD[2].evidence }, ...GOOD.slice(2)] })), async (calls) => {
  const out = await generate(INPUT);
  assert.equal(out.questions.length, 5);
  assert.equal(out.rejectedCount, 2);
  assert.equal(out.review.reviewed, 5);
  assert.doesNotMatch(calls[1].prompt, /LIFO 스택/);
}));

test('키 없음: 503 ai_not_configured, 호출 없음', () => withFakeAI(script(() => text({ questions: GOOD })), async (calls) => {
  delete process.env.KOOKMIN_KEY;
  await expectFail(() => generate(INPUT), 503, 'ai_not_configured');
  assert.equal(calls.length, 0);
}));

test('공급자 오류: 500은 502 ai_failed, 403은 크레딧 안내', () => withFakeAI((st, p, n) => ({ status: n === 1 ? 500 : 403, body: { error: { message: 'boom' } } }), async () => {
  const a = await expectFail(() => generate(INPUT), 502, 'ai_failed');
  assert.doesNotMatch(a.message, /크레딧/);
  const b = await expectFail(() => generate(INPUT), 502, 'ai_failed');
  assert.match(b.message, /크레딧/);
}));

test('입력 검사: 쪽 없음·20쪽 초과·글자 부족·40,000자 초과는 400', () => {
  const bad = (body) => { try { readInput(body); return null; } catch (e) { return e; } };
  assert.equal(bad({ pages: [] }).body.error, 'invalid_input');
  assert.equal(bad({ pages: Array.from({ length: 21 }, (_, i) => ({ page: i + 1, text: 'x'.repeat(50) })) }).status, 400);
  assert.match(bad({ pages: [{ page: 1, text: '짧다' }] }).message, /너무 적어요/);
  assert.match(bad({ pages: [{ page: 1, text: '가'.repeat(40001) }] }).message, /너무 많아요/);
});
