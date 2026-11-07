#!/usr/bin/env npx tsx
/** Shared grammar and its citation consumers; run with npx tsx. */
import * as ids from "./lib/mem-id.js";
import {
  LEGACY_MEM_ID_PATTERN, DATED_MEM_ID_PATTERN, MEM_ID_PATTERN,
  isMemId, parseMemId, compareMemIds,
} from "./lib/mem-id.js";
import {
  distinctCitedKeysInLine, firstCitations, extractHook, isReliableHook, sortKeys,
} from "./lib/citation-detect.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else { failed++; console.error(`❌ FAIL: ${message}`); }
}
const A = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const UPPER = A.slice(0, 22) + A.slice(22).toUpperCase();
for (const value of ["MEM-0", "MEM-1", "MEM-001", A, B, UPPER,
  A.replace("2026-11-07-203000", "9999-99-99-999999")]) {
  assert(isMemId(value), `syntactically valid: ${value}`);
}
for (const value of ["", "MEM-feedback", "mem-1", "MEM--1", "MEM-1x", " MEM-1", "MEM-1\n",
  A + "0", A.slice(0, -1), A.replace("203000", "20300"), A.replace("4ccc", "4ccg"),
  A.replace("11-07", "1-07"), A.replace("203000-", "203000"), A + ":obsolete"]) {
  assert(!isMemId(value), `invalid identity: ${JSON.stringify(value)}`);
}
assert(JSON.stringify(parseMemId("MEM-12")) === JSON.stringify({ kind: "legacy", n: 12 }), "parse legacy");
assert(JSON.stringify(parseMemId(UPPER)) === JSON.stringify({ kind: "dated", date: "2026-11-07", time: "203000", uuid: UPPER.slice(22) }), "parse dated preserves UUID case");
assert(parseMemId("MEM-bad") === null, "invalid parse returns null");
assert(new RegExp(`^${DATED_MEM_ID_PATTERN}$`).test(A), "exported dated grammar");
assert(new RegExp(`^${LEGACY_MEM_ID_PATTERN}$`).test("MEM-12"), "exported legacy grammar");
for (const value of [A, A.replace("eeeeeeeeeeee", "broken"), "MEM-2026-11", "MEM-2026-1"]) {
  assert(!new RegExp(LEGACY_MEM_ID_PATTERN).test(value), `legacy never matches a dated prefix, including by backtracking: ${value}`);
}
assert(new RegExp(MEM_ID_PATTERN).exec(A)?.[0] === A, "combined grammar tries dated first");
const chronological = ["MEM-2", "MEM-12", A.replace("2026-11-07", "2025-12-31"),
  A.replace("203000", "202959"), UPPER, A, B, A.replace("203000", "203001"), A.replace("11-07", "11-08")];
assert([...chronological].reverse().sort(compareMemIds).join(",") === chronological.join(","), "numeric first, then date/time/lowercase UUID, then exact spelling");
assert(compareMemIds("MEM-9007199254740992", "MEM-9007199254740993") < 0, "numeric ordering is exact beyond Number precision");
assert(compareMemIds("MEM-12", "MEM-invalid") < 0, "invalid inputs sort consistently after valid identities");
assert(compareMemIds("MEM-01", "MEM-1") !== 0, "distinct legacy spellings have deterministic tie break");
for (const a of chronological) {
  assert(compareMemIds(a, a) === 0, `comparator reflexive for ${a}`);
  for (const b of chronological) {
    assert(Math.sign(compareMemIds(a, b)) === -Math.sign(compareMemIds(b, a)), "comparator is antisymmetric");
  }
}
assert(sortKeys([B, "MEM-12", A, "MEM-2"]).join(",") === ["MEM-2", "MEM-12", A, B].join(","), "citation sorter uses shared ordering");
assert(distinctCitedKeysInLine("MEM-1/2/3, MEM-4,5,6").join(",") === "MEM-1,MEM-2,MEM-3,MEM-4,MEM-5,MEM-6", "legacy clusters unchanged");
assert(distinctCitedKeysInLine(`[${A}] [${B}] MEM-1/2`).join(",") === [A, B, "MEM-1", "MEM-2"].join(","), "two dated citations never collapse to MEM-2026");
assert(distinctCitedKeysInLine(`${A}/2 ${B},3`).join(",") === [A, B].join(","), "dated IDs cannot form numeric clusters");
assert(distinctCitedKeysInLine(`${A} ${UPPER}`).length === 2, "case-distinct UUID spellings remain distinct identities");
assert(distinctCitedKeysInLine("MEM-2026-11-07-broken").length === 0, "invalid dated tag never becomes a legacy prefix");
for (const key of ["MEM-12", A, UPPER]) {
  assert(distinctCitedKeysInLine(`[${key}:obsolete]`).join(",") === key, "lifecycle suffix is outside identity");
  for (const tag of [`[${key}]`, `\`[${key}]\``, `\`${key}\``, `[${key}:obsolete]`]) {
    assert(extractHook({ file: "semantic/a.md", line: 1, lineText: "unused", heading: `${tag} Preserve the complete memo identity ${tag}` }) === "Preserve the complete memo identity", `strip balanced leading/trailing tag ${tag}`);
  }
  assert(!isReliableHook(`Never embed ${key} inside a hook`), "embedded complete key makes hook unreliable");
}
const scan = firstCitations([{ file: "semantic/a.md", text: [
  "### Preserve complete dated identities",
  `Unowned mixed citation ${A} ${B}`,
  `- [${A}:obsolete] Subject narrative mentioning [${B}]`,
  `Dedicated second memo [${B}]`,
  `Later first memo [${A}]`,
].join("\n") }]);
assert(scan.citations.size === 2 && scan.citations.get(A)?.line === 3 && scan.citations.get(B)?.line === 4,
  "first-citation lookup and subject tags preserve distinct IDs and first evidence");
const indexes = firstCitations([{ file: "semantic/a.md", text: [
  "### Index shape rejection",
  `- [${A}] [[one]] · [[two]]`,
  `| ${B} | semantic/other.md |`,
].join("\n") }]);
assert(indexes.citations.size === 0 && indexes.indexRejections.map((r) => r.key).join(",") === [A, B].join(","),
  "citation stripping removes whole dated tokens before residual prose/index detection");
// Allocator: injected non-UTC clock, platform full UUID, lowercase, no counter.
assert(typeof ids.newMemId === "function", "allocator exported");
if (typeof ids.newMemId === "function") {
  const stamp = new Date("2026-01-01T00:00:01.999+02:00");
  const id = ids.newMemId(stamp);
  const parsed = parseMemId(id);
  assert(isMemId(id) && parsed?.kind === "dated", "allocated ID satisfies shared grammar");
  assert(parsed?.kind === "dated" && parsed.date === "2025-12-31" && parsed.time === "220001", "allocator uses UTC including date rollover and zero padding");
  assert(parsed?.kind === "dated" && parsed.uuid === parsed.uuid.toLowerCase() && parsed.uuid.length === 36 && parsed.uuid[14] === "4" && "89ab".includes(parsed.uuid[19]), "allocator emits lowercase full platform v4 UUID");
  assert(ids.newMemId(stamp) !== id, "same instant still allocates distinct random IDs");
  assert(isMemId(ids.newMemId()), "default clock allocates a valid ID");
}
console.log(`${passed} assertions passed, ${failed} failed`);
if (failed) process.exitCode = 1;
