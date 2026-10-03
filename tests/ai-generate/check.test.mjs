// 형식·근거·중복 검사(비용 없음). 합성 입력으로 검사 규칙을 확인한다 — 모델 품질 측정이 아니다.
// 1절 재현(2026-10-03 15:29, 변경 전 코드): 사례 1~4가 모두 통과했다. 변경 뒤 3·4는 글자 검사로 거절되고
// 1·2는 여전히 글자 검사로 잡을 수 없어 pipeline.test.mjs의 검토 단계가 맡는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { check, squash, newSeen } = require('../../ai-generate.js');

const PAGE = '스택은 가장 나중에 들어온 데이터를 가장 먼저 꺼내는 자료구조다(LIFO). 큐는 먼저 들어온 데이터를 먼저 꺼내는 자료구조다(FIFO). 배열은 연속 메모리에 원소를 저장한다. 연결 리스트는 노드가 다음 노드를 가리킨다.';
const pageText = new Map([[1, squash(PAGE)]]);
const quote = '스택은 가장 나중에 들어온 데이터를 가장 먼저 꺼내는 자료구조다';
const base = { concept: '스택', type: '정의', body: '가장 나중에 들어온 데이터를 가장 먼저 꺼내는 자료구조는 무엇인가?', choices: ['큐', '스택', '힙', '배열'], answer_index: 1, explanation: '스택은 나중에 들어온 데이터를 먼저 꺼낸다.', evidence: { page: 1, quote } };

test('사례 1·2(정답 오류·해설 모순)는 글자 검사로 잡히지 않는다 — 검토 단계가 맡는다', () => {
  const wrong = check({ ...base, answer_index: 0, explanation: '큐는 나중에 들어온 데이터를 먼저 꺼낸다.' }, pageText, newSeen());
  assert.equal(typeof wrong, 'object');
  const contradict = check({ ...base, explanation: '큐는 먼저 들어온 데이터를 먼저 꺼내므로 정답은 큐다.' }, pageText, newSeen());
  assert.equal(typeof contradict, 'object');
});

test('사례 3: 한 보기가 다른 보기를 포함하면 거절한다', () => {
  assert.equal(check({ ...base, choices: ['큐', '스택', 'LIFO 스택', '배열'] }, pageText, newSeen()), '보기가 서로 포함');
  assert.equal(check({ ...base, choices: ['큐', 'FIFO', 'FIFO 큐', '배열'] }, pageText, newSeen()), '보기가 서로 포함');
});

test('1자 보기(n, 2n)는 포함 검사에서 뺀다', () => {
  const r = check({ ...base, body: '정점이 n개인 트리의 간선 수는 얼마인가?', choices: ['n − 1', 'n', 'n + 1', '2n'], answer_index: 0, evidence: { page: 1, quote: '연결 리스트는 노드가 다음 노드를 가리킨다' } }, pageText, newSeen());
  assert.equal(typeof r, 'object');
});

test('사례 4: 같은 근거·같은 보기로 문장만 바꾼 반복을 거절한다', () => {
  const seen = newSeen();
  assert.equal(typeof check(base, pageText, seen), 'object');
  const reworded = { ...base, concept: '자료구조 LIFO', body: '나중에 넣은 데이터를 먼저 꺼내는 구조의 이름은?' };
  assert.equal(check(reworded, pageText, seen), '같은 근거 반복');
  const otherQuote = { ...reworded, evidence: { page: 1, quote: '큐는 먼저 들어온 데이터를 먼저 꺼내는 자료구조다' } };
  assert.equal(check(otherQuote, pageText, seen), '같은 보기 반복');
  const otherChoices = { ...otherQuote, choices: ['큐', '스택', '트리', '그래프'] };
  const r = check(otherChoices, pageText, seen);
  assert.equal(typeof r, 'object', `거절됨: ${r}`);
});

test('문제 문장이 거의 같으면(2그램 자카드 0.6 이상) 거절한다', () => {
  const seen = newSeen();
  assert.equal(typeof check(base, pageText, seen), 'object');
  const near = { ...base, concept: '다른 개념', body: '가장 나중에 들어온 데이터를 가장 먼저 꺼내는 자료구조는 무엇일까?', choices: ['큐', '스택', '트리', '그래프'], evidence: { page: 1, quote: '큐는 먼저 들어온 데이터를 먼저 꺼내는 자료구조다' } };
  assert.equal(check(near, pageText, seen), '비슷한 문제');
});

test('같은 개념을 두 번 내면 거절한다', () => {
  const seen = newSeen();
  assert.equal(typeof check(base, pageText, seen), 'object');
  const sameConcept = { ...base, body: '스택에서 마지막에 넣은 원소를 꺼내는 연산의 결과는 무엇과 같은가?', choices: ['가장 먼저 넣은 원소', '가장 나중에 넣은 원소', '중간 원소', '임의 원소'], answer_index: 1, evidence: { page: 1, quote: '큐는 먼저 들어온 데이터를 먼저 꺼내는 자료구조다' } };
  assert.equal(check(sameConcept, pageText, seen), '같은 개념 반복');
});

test('기존 검사는 그대로다: 보기 수·정답 번호·해설·근거 쪽·근거 문장', () => {
  assert.equal(check({ ...base, choices: ['큐', '스택', '힙'] }, pageText, newSeen()), '선택지 4개 아님');
  assert.equal(check({ ...base, choices: ['큐', '스택', '스택', '힙'] }, pageText, newSeen()), '선택지 중복');
  assert.equal(check({ ...base, answer_index: 4 }, pageText, newSeen()), '정답 번호 오류');
  assert.equal(check({ ...base, explanation: '' }, pageText, newSeen()), '해설 없음');
  assert.equal(check({ ...base, evidence: { page: 2, quote } }, pageText, newSeen()), '근거 쪽이 범위 밖');
  assert.equal(check({ ...base, evidence: { page: 1, quote: '교안에 없는 문장이 들어간 인용' } }, pageText, newSeen()), '근거 문장이 교안에 없음');
  assert.equal(check(null, pageText, newSeen()), '형식 오류');
});

test('통과 문항에 concept·type이 붙고 모르는 type은 null이다', () => {
  const r = check({ ...base, type: '서술' }, pageText, newSeen());
  assert.equal(r.concept, '스택');
  assert.equal(r.type, null);
  const t = check({ ...base, type: '비교' }, pageText, newSeen());
  assert.equal(t.type, '비교');
});

test('이전 방식(Set)으로 seen을 넘겨도 동작한다', () => {
  const seen = new Set();
  assert.equal(typeof check(base, pageText, seen), 'object');
  assert.equal(check(base, pageText, seen), '중복 문제');
});
