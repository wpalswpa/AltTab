// 실제 server.js를 띄우고 가짜 학교 AI(KOOKMIN_BASE_URL)로 /api/generate의 HTTP 계약(200·400·503)을 확인한다. 비용 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(await readFile(path.join(root, 'tests/ai-generate/fixtures/tuning-data-structures.json'), 'utf8'));
const S = (page, needle) => { const t = fixture.pages[page - 1].text; const i = t.indexOf(needle); assert.ok(i >= 0, needle); return t.slice(i, t.indexOf('.', i) + 1); };
const Q = [
  { concept: '스택', type: '정의', body: '가장 나중에 들어온 데이터를 가장 먼저 꺼내는 자료구조는?', choices: ['큐', '스택', '배열', '해시 테이블'], answer_index: 1, page: 1, quote: S(1, '스택은 가장 나중에') },
  { concept: '큐', type: '비교', body: '스택과 달리 먼저 들어온 데이터를 먼저 꺼내는 자료구조는?', choices: ['트리', '그래프', '큐', '연결 리스트'], answer_index: 2, page: 1, quote: S(1, '큐는 먼저 들어온') },
  { concept: '배열', type: '적용', body: '인덱스로 원소 하나에 바로 접근할 수 있는 저장 방식은?', choices: ['연결 리스트', '배열', '스택', '큐'], answer_index: 1, page: 2, quote: S(2, '배열은 연속된') },
  { concept: '연결 리스트', type: '정의', body: '각 노드가 데이터와 다음 노드의 주소를 가지는 자료구조는?', choices: ['배열', '해시 테이블', '연결 리스트', '트리'], answer_index: 2, page: 2, quote: S(2, '연결 리스트는 각 노드가') },
  { concept: '이진 탐색', type: '적용', body: '정렬된 배열의 원소가 1,024개일 때 이진 탐색의 최대 비교 횟수는?', choices: ['5번', '10번', '512번', '1,024번'], answer_index: 1, page: 3, quote: S(3, '원소가 1,024개이면') },
  { concept: '해시 테이블', type: '정의', body: '키를 해시 함수에 넣어 저장 위치를 정하는 자료구조는?', choices: ['스택', '큐', '트리', '해시 테이블'], answer_index: 3, page: 3, quote: S(3, '해시 테이블은 키를') },
  { concept: '선형 탐색', type: '정의', body: '첫 원소부터 차례로 비교하며 값을 찾는 탐색은?', choices: ['이진 탐색', '선형 탐색', '해시 탐색', '너비 우선 탐색'], answer_index: 1, page: 3, quote: S(3, '선형 탐색은 첫 원소부터') },
].map((x) => ({ concept: x.concept, type: x.type, body: x.body, choices: x.choices, answer_index: x.answer_index, explanation: `정답은 ${x.choices[x.answer_index]}이다. 교안에 "${x.quote}"라고 적혀 있다.`, evidence: { page: x.page, quote: x.quote } }));
const byBody = new Map(Q.map((x) => [x.body, x]));
const listed = (p) => [...p.matchAll(/^\[(c\d+)\] (.+)$/gm)].map((m) => ({ id: m[1], body: m[2] }));

function fakeAI() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const p = JSON.parse(raw).messages[0].content;
      let out;
      if (p.includes('"questions":[')) { calls.push('generate'); out = { questions: Q }; }
      else if (p.includes('"single_answer"')) { calls.push('solve'); out = { results: listed(p).map(({ id, body }) => { const g = byBody.get(body); return { id, single_answer: true, chosen: g.answer_index, evidence_quote: g.evidence.quote, per_choice: [0, 1, 2, 3].map((i) => ({ index: i, verdict: i === g.answer_index ? 'correct' : 'wrong', reason: '교안' })) }; }) }; }
      else { calls.push('audit'); out = { results: listed(p).map(({ id, body }) => ({ id, explanation_answer_index: byBody.get(body).answer_index, consistent: true, reason: '해설이 정답을 설명' })) }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }] }));
    });
  });
  return { server, calls };
}

async function withServer(env, fn) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'alttab-ai-http-'));
  const port = env.PORT;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, VERCEL: '1', TMPDIR: temp, TEMP: temp, TMP: temp, SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', KOOKMIN_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !output.includes('server running')) {
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.match(output, /server running/);
    return await fn(`http://127.0.0.1:${port}`, () => output);
  } finally {
    child.kill();
    await rm(temp, { recursive: true, force: true });
  }
}

const post = (origin, body) => fetch(`${origin}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const payload = { title: fixture.title, range: { from: 1, to: 3 }, pages: fixture.pages, count: 5 };

test('/api/generate: 가짜 AI로 200 계약, 잘못된 입력 400, 응답·로그에 키 없음', async () => {
  const { server, calls } = fakeAI();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    await withServer({ PORT: '3497', KOOKMIN_BASE_URL: `http://127.0.0.1:${server.address().port}`, KOOKMIN_KEY: 'dummy-not-a-real-key', KOOKMIN_MODEL: 'fake-model' }, async (origin, log) => {
      const r = await post(origin, payload);
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.ok, true);
      assert.equal(data.source, 'school-ai');
      assert.equal(data.model, 'fake-model');
      assert.equal(data.questions.length, 5);
      assert.deepEqual(data.questions.map((x) => x.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
      for (const x of data.questions) {
        assert.equal(x.choices.length, 4);
        assert.ok(Number.isInteger(x.answerIndex) && x.answerIndex >= 0 && x.answerIndex < 4);
        assert.ok(x.explanation && x.evidence.page && x.evidence.quote);
      }
      assert.equal(data.review.method, 'same-model-blind-solve');
      assert.equal(data.review.calls, 3);
      assert.deepEqual(calls, ['generate', 'solve', 'audit']);
      assert.doesNotMatch(JSON.stringify(data), /dummy-not-a-real-key/);
      // 같은 내용을 다시 보내면 서버는 다시 생성한다(브라우저 저장은 클라이언트 몫). 동시 요청 합치기는 진행 중일 때만이다.
      const bad = await post(origin, { title: 't', pages: [] });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { ok: false, error: 'invalid_input', message: '문제를 만들 쪽을 골라 주세요' });
      const tooMany = await post(origin, { title: 't', pages: Array.from({ length: 21 }, (_, i) => ({ page: i + 1, text: 'x'.repeat(30) })) });
      assert.equal(tooMany.status, 400);
      assert.doesNotMatch(log(), /dummy-not-a-real-key/);
    });
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
});

test('/api/generate: KOOKMIN_KEY가 없으면 503 ai_not_configured', async () => {
  await withServer({ PORT: '3498', KOOKMIN_KEY: '' }, async (origin) => {
    const r = await post(origin, payload);
    assert.equal(r.status, 503);
    const data = await r.json();
    assert.equal(data.error, 'ai_not_configured');
    assert.ok(!('questions' in data));
  });
});
