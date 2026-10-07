// Read-only review of the real eligibility function. No DB, network, or AI calls.
// Run with Node 24: node scripts/business-flow-check.mjs
// DB rows are test fixtures, not actual users or a validated SQL view.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const path = new URL('../lib/review.ts', import.meta.url);
const source = readFileSync(path, 'utf8');
assert.match(source, /import \{ db \} from "\.\/supabase-admin";/);
// Replace only the dependency binding and module exports; retain function logic.
const executable = stripTypeScriptTypes(
  source.replace(/import \{ db \} from "\.\/supabase-admin";/, '')
).replace(/export /g, '');
const load = new Function('db', `${executable}\nreturn playableQuestionIds;`);
const rows = Array.from({ length: 5 }, (_, i) => ({
  question_id: `q${i}`, author_id: 'author', concept_id: 'concept',
  difficulty: 1, status: 'first_pass',
}));
let reviews = [];
const db = () => ({ from(table) {
  let selected = table === 'question_status' ? rows : reviews;
  const query = {
    select() { return query; },
    eq(key, value) { selected = selected.filter(row => row[key] === value); return query; },
    neq(key, value) { selected = selected.filter(row => row[key] !== value); return query; },
    in(key, values) { selected = selected.filter(row => values.includes(row[key])); return query; },
    then(resolve, reject) { return Promise.resolve({ data: selected, error: null }).then(resolve, reject); },
  };
  return query;
} });
const playable = load(db);
const ids = async user => playable(user, 'concept', 1);
assert.equal((await ids('new-student')).length, 0);
console.log('PASS: first-pass questions alone give a new student 0 playable questions');
assert.equal((await ids('author')).length, 5);
console.log('PASS: the author can play their 5 first-pass questions');
reviews = rows.map(row => ({ question_id: row.question_id, reviewer_id: 'reviewer', stage: 2, verdict: 'pass' }));
assert.equal((await ids('reviewer')).length, 5);
assert.equal((await ids('new-student')).length, 0);
console.log('PASS: one reviewer can play; an unrelated new student still cannot');
rows.forEach(row => { row.status = 'verified'; });
assert.equal((await ids('new-student')).length, 5);
console.log('PASS: verified questions are playable by the new student');
rows.forEach(row => { row.status = 'hidden'; });
assert.equal((await ids('author')).length, 0);
assert.equal((await ids('reviewer')).length, 0);
console.log('PASS: hidden questions are excluded for author and reviewer');
const paymentSource = readFileSync(new URL('../app/api/payments/route.ts', import.meta.url), 'utf8');
const coursePrice = Number(paymentSource.match(/course_pass:\s*\{\s*amount:\s*(\d+)/)?.[1]);
const subscriptionPrice = Number(paymentSource.match(/exam_30d:\s*\{\s*amount:\s*(\d+)/)?.[1]);
assert.ok(Number.isFinite(coursePrice) && Number.isFinite(subscriptionPrice), 'Read prices from the payment route');
assert.ok(coursePrice * 3 < subscriptionPrice && coursePrice * 4 > subscriptionPrice);
console.log(`PASS: 3 course passes cost ${coursePrice * 3}; 4 cost ${coursePrice * 4} (30-day subscription: ${subscriptionPrice})`);
console.log('LIMIT: SQL status aggregation, real DB, browser, AI, and demand were not tested');
