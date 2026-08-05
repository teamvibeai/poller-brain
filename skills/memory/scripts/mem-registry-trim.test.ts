#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the MEM_REGISTRY promoted-row trim logic.
 *
 * Runs the count-verify conditions against string fixtures (no fs):
 *   - promotion gate: a row is trimmed only if its key has a genuine
 *     single-key citation in a destination file
 *   - multi-key-line rejection: a line citing 2+ distinct MEM-N keys is
 *     never trusted as evidence for ANY of them, whether the keys arrive
 *     via one compact cluster (`MEM-93/94/122`) or via separate bracket
 *     tags on the same line (`[MEM-172] ... ([MEM-166])`) — regression
 *     test for the "family/sibling cross-reference" false positive
 *     DevGuru caught against real data (poller-brain#244 review): such
 *     lines look identical to genuine condensed prose without reading for
 *     meaning, so both shapes are rejected rather than guessed at
 *   - scan-past-rejection: if a key also has a genuine single-key citation
 *     elsewhere, that citation is still found and used (the key isn't
 *     penalized just because it *also* appears on an ambiguous line)
 *   - idempotence gate: a row already rewritten to a pointer is left alone,
 *     a second consecutive run is a byte-identical no-op
 *   - Key/Status/Created columns are never rewritten, only Obsoleted +
 *     Description
 *   - a row never cited anywhere (or only ever cited ambiguously) stays
 *     untouched
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

// A fixture mirroring the real registry shape: one clean single-key match,
// one compact multi-key cluster (all 3 keys must be rejected), one pair
// cited together via separate bracket tags on one line (must be rejected
// for both, unless a key also has a genuine single-key citation
// elsewhere), and one row never cited anywhere.
const REGISTRY = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-99 | ACTIVE | 2026-07-28 | — | full narrative about the data-loss-step rule, already promoted verbatim into LEARNINGS.md |
| MEM-93 | ACTIVE | 2026-07-28 | — | full narrative about the bounded-field rule — only ever cited as part of a 3-key family cluster |
| MEM-94 | ACTIVE | 2026-07-28 | — | second half of the same 3-key family cluster — never cited alone anywhere |
| MEM-122 | ACTIVE | 2026-07-28 | — | third of the same 3-key family cluster — never cited alone anywhere |
| MEM-166 | ACTIVE | 2026-07-30 | — | live investigation narrative — only ever mentioned in passing on a line whose real subject is MEM-172 |
| MEM-172 | ACTIVE | 2026-07-30 | — | correction narrative that ALSO has its own dedicated single-key recap line elsewhere |
| MEM-200 | ACTIVE | 2026-07-28 | — | full narrative that has never been promoted anywhere — must stay untouched |
`;

const DESTINATIONS: DestinationFile[] = [
  {
    file: "core/LEARNINGS.md",
    text: [
      "- **NIKDY žádný krok způsobující ztrátu dat** — data-loss-step rule text. [MEM-99]",
      "- **bounded-field rule** — cap every new field you add. [MEM-93/94/122]",
      "- **[MEM-172] correction:** the suspicious thing was a false positive ([MEM-166]).",
      "- **[MEM-172] dedicated recap:** the monitoring pipeline is confirmed working end-to-end.",
    ].join("\n"),
  },
];

// --- Run 1: fresh trim -------------------------------------------------------
const r1 = trimPromotedRows(REGISTRY, DESTINATIONS);
const c1 = verifyTrimStats(r1.stats);

assert(r1.stats.totalDataRows === 7, "should find 7 data rows");
assert(r1.stats.alreadyPointer === 0, "no rows are pointers yet on a fresh registry");
assert(r1.stats.candidateRows === 7, "all 7 rows are candidates");
assert(
  r1.stats.trimmedRows === 2,
  "only MEM-99 (clean single-key) and MEM-172 (has its own dedicated single-key line) trim"
);
assert(
  r1.stats.trimmedKeys.join(",") === "MEM-99,MEM-172",
  "trimmed exactly the correct keys, sorted numerically"
);
assert(c1.length === 3, "all 3 verify checks passed");

// Multi-key cluster line: none of the 3 family keys are trusted as evidence.
for (const key of ["MEM-93", "MEM-94", "MEM-122"]) {
  assert(
    new RegExp(`\\| ${key} \\| ACTIVE \\| 2026-07-28 \\| — \\|`).test(r1.registry),
    `${key} (only cited in the 3-key family cluster) stays untouched — multi-key-line rejection`
  );
}

// Separate-bracket-tags-on-one-line case: MEM-166 has no OTHER citation, so it stays untouched.
assert(
  /\| MEM-166 \| ACTIVE \| 2026-07-30 \| — \|/.test(r1.registry),
  "MEM-166 (only ever co-cited with MEM-172 on one line) stays untouched"
);

// MEM-172 IS trimmed, but must point at its own dedicated line, not the shared ambiguous one.
assert(
  /\| MEM-172 \| ACTIVE \| 2026-07-30 \| core\/LEARNINGS\.md:4 \| see core\/LEARNINGS\.md — \[MEM-172\] dedicated recap: \|/.test(
    r1.registry
  ),
  "MEM-172 trimmed using its OWN single-key line (line 4), not the ambiguous shared line (line 3) — scan-past-rejection"
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
assert(
  /\| MEM-200 \| ACTIVE \| 2026-07-28 \| — \| full narrative that has never been promoted anywhere — must stay untouched \|/.test(
    r1.registry
  ),
  "MEM-200 (never cited) is left completely untouched"
);

assert(r1.stats.bytesAfter < r1.stats.bytesBefore, "registry shrank");

// --- Run 2: idempotence — feed run-1 output back in --------------------------
const r2 = trimPromotedRows(r1.registry, DESTINATIONS);
verifyTrimStats(r2.stats);
assert(r2.stats.trimmedRows === 0, "run 2 trims nothing new");
assert(r2.stats.alreadyPointer === 2, "run 2 finds MEM-99 + MEM-172 as already-pointers");
assert(r2.stats.candidateRows === 5, "run 2 has the remaining 5 rows as candidates");
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
