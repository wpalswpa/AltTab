// FR-12 생성 품질 점검(저장 없음): 개념별 문항 수, 정답이 근거 쪽 원문에 들어 있는지, 중복, 전체 문항 목록.
// 실행: node --env-file=.env.local scripts/generate-quality.ts [교안 JSON 경로]
import { readFileSync } from "node:fs";
import { chunkPages } from "../lib/chunk.ts";
import { generateFirstUnit } from "../lib/ai/generate.ts";
import { normalizeBody } from "../lib/rules.ts";

const src = process.argv[2] ?? "demo/os-demo-pages.json";
const pages = JSON.parse(readFileSync(src, "utf8")).pages;
const chunks = chunkPages(pages).map((c) => ({ ref: `1:${c.page}`, text: c.content }));
const textOf = new Map(chunks.map((c) => [c.ref, c.text]));
const t0 = Date.now();
const r = await generateFirstUnit(chunks);
console.log(`${r.provider} ${r.model}, ${Math.round((Date.now() - t0) / 1000)}초`);

const perConcept = new Map<string, number>();
for (const q of r.questions) perConcept.set(String(q.concept), (perConcept.get(String(q.concept)) ?? 0) + 1);
console.log("개념별 문항 수:", [...perConcept].map(([k, v]) => `${k} ${v}`).join(" / "));

let answerInText = 0;
const bodies = new Set<string>();
let dup = 0;
r.questions.forEach((q, i) => {
  const ev = ((q.evidence_refs as string[]) ?? []).map((x) => textOf.get(x) ?? "").join(" ");
  const inText = normalizeBody(ev).includes(normalizeBody(String(q.answer)));
  if (inText) answerInText++;
  const key = `${q.concept}|${normalizeBody(String(q.body))}`;
  if (bodies.has(key)) dup++;
  bodies.add(key);
  console.log(`${String(i + 1).padStart(2)}. [${q.concept}] ${q.body} → ${q.answer}${inText ? "" : "  (정답 문구가 근거 쪽 원문에 그대로는 없음)"}`);
});
console.log(`정답 문구가 근거 쪽 원문에 그대로 있음 ${answerInText}/${r.questions.length}, 같은 개념 안 본문 중복 ${dup}`);
