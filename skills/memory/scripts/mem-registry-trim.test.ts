#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the MEM_REGISTRY promoted-row trim logic.
 *
 * Runs the count-verify conditions against string fixtures (no fs):
 *   - promotion gate: a row is trimmed only if its key is cited in a
 *     destination file
 *   - cluster-citation parsing: non-first keys in a compact multi-key
 *     citation (`MEM-93/94/122`, `MEM-116/117`) are found, not just the
 *     first — regression test for the naive-substring miss DevGuru caught
 *     against a real 24-key sample (poller-brain#244)
 *   - idempotence gate: a row already rewritten to a pointer is left alone,
 *     a second consecutive run is a byte-identical no-op
 *   - Key/Status/Created columns are never rewritten, only Obsoleted +
 *     Description
 *   - a row never cited anywhere stays untouched
 *   - size never grows
 *
 * Run: npx tsx skills/memory/scripts/mem-registry-trim.test.ts
 * Exits non-zero on the first failed assertion.
 */

import {
  trimPromotedRows,
  verifyTrimStats,
  type DestinationFile,
} from "./lib/mem-registry-trim-core.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// A fixture mirroring the real registry shape: a data table with a mix of
// already-promoted rows (some compactly cross-cited), and one row never
// promoted anywhere.
const REGISTRY = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-99 | ACTIVE | 2026-07-28 | — | full narrative about the data-loss-step rule, already promoted verbatim into LEARNINGS.md |
| MEM-93 | ACTIVE | 2026-07-28 | — | full narrative about the bounded-field rule, cited compactly as MEM-93/94/122 |
| MEM-94 | ACTIVE | 2026-07-28 | — | second half of the same compact citation — never cited alone anywhere |
| MEM-116 | ACTIVE | 2026-07-28 | — | full narrative about inbox pickup, compact-cited alongside MEM-117 |
| MEM-117 | ACTIVE | 2026-07-28 | — | narrative only ever cited as the non-first key of the compact MEM-116/117 pair |
| MEM-200 | ACTIVE | 2026-07-28 | — | full narrative that has never been promoted anywhere — must stay untouched |
`;

const DESTINATIONS: DestinationFile[] = [
  {
    file: "core/LEARNINGS.md",
    text: [
      "- **NIKDY žádný krok způsobující ztrátu dat** — data-loss-step rule text. [MEM-99]",
      "- **bounded-field rule** — cap every new field you add. [MEM-93/94/122]",
      "- **inbox pickup nuance** — pickup proves dequeue, not completion. [MEM-116/117]",
    ].join("\n"),
  },
];

// --- Run 1: fresh trim -------------------------------------------------------
const r1 = trimPromotedRows(REGISTRY, DESTINATIONS);
const c1 = verifyTrimStats(r1.stats);

assert(r1.stats.totalDataRows === 6, "should find 6 data rows");
assert(r1.stats.alreadyPointer === 0, "no rows are pointers yet on a fresh registry");
assert(r1.stats.candidateRows === 6, "all 6 rows are candidates");
assert(r1.stats.trimmedRows === 5, "5 of 6 rows are cited somewhere (all but MEM-200)");
assert(
  r1.stats.trimmedKeys.join(",") === "MEM-93,MEM-94,MEM-99,MEM-116,MEM-117",
  "trimmed the correct keys, sorted numerically"
);
assert(c1.length === 3, "all 3 verify checks passed");

// The regression case: non-first keys in a compact cluster must be found.
assert(
  /\| MEM-94 \|.*\| see core\/LEARNINGS\.md — bounded-field rule \|/.test(r1.registry),
  "MEM-94 (non-first key in MEM-93/94/122) was trimmed — cluster-parse regression guard"
);
assert(
  /\| MEM-117 \|.*\| see core\/LEARNINGS\.md — inbox pickup nuance \|/.test(r1.registry),
  "MEM-117 (non-first key in MEM-116/117) was trimmed — cluster-parse regression guard"
);

// Pointer rows carry file:line in Obsoleted, "see file — hook" in Description.
assert(
  /\| MEM-99 \| ACTIVE \| 2026-07-28 \| core\/LEARNINGS\.md:1 \| see core\/LEARNINGS\.md — NIKDY žádný krok způsobující ztrátu dat \|/.test(
    r1.registry
  ),
  "MEM-99 rewritten to a pointer with correct file:line and hook"
);

// Key/Status/Created are byte-identical — only Obsoleted+Description change.
assert(/\| MEM-99 \| ACTIVE \| 2026-07-28 \|/.test(r1.registry), "MEM-99 Key/Status/Created untouched");
assert(/\| MEM-200 \| ACTIVE \| 2026-07-28 \| — \| full narrative that has never been promoted anywhere — must stay untouched \|/.test(r1.registry),
  "MEM-200 (never cited) is left completely untouched");

assert(r1.stats.bytesAfter < r1.stats.bytesBefore, "registry shrank");

// --- Run 2: idempotence — feed run-1 output back in --------------------------
const r2 = trimPromotedRows(r1.registry, DESTINATIONS);
verifyTrimStats(r2.stats);
assert(r2.stats.trimmedRows === 0, "run 2 trims nothing new");
assert(r2.stats.alreadyPointer === 5, "run 2 finds all 5 as already-pointers");
assert(r2.stats.candidateRows === 1, "run 2 has only MEM-200 as a remaining candidate");
assert(r2.registry === r1.registry, "run 2 registry is byte-identical (idempotent)");

// --- verifyTrimStats FAIL LOUD on a broken invariant -------------------------
let threw = false;
try {
  verifyTrimStats({
    totalDataRows: 1,
    alreadyPointer: 0,
    candidateRows: 1,
    trimmedRows: 1,
    trimmedKeys: ["MEM-1"],
    bytesBefore: 100,
    bytesAfter: 150, // grew — must throw
  });
} catch {
  threw = true;
}
assert(threw, "verifyTrimStats throws when registry size grows");

console.log(`✅ all ${passed} assertions passed`);
