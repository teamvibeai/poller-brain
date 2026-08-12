#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the MEM_REGISTRY promoted-row trim logic.
 *
 * Runs the count-verify conditions against string fixtures (no fs):
 *   - findTrimCandidates is read-only and never mutates the registry
 *   - promotion gate: a candidate is proposed only if its key has a
 *     genuine single-key citation in a destination file
 *   - multi-key-line rejection: a line citing 2+ distinct MEM-N keys is
 *     never proposed as evidence for ANY of them, whether the keys arrive
 *     via one compact cluster (`MEM-93/94/122`) or via separate bracket
 *     tags on the same line (`[MEM-172] ... ([MEM-166])`)
 *   - scan-past-rejection: if a key also has a genuine single-key citation
 *     elsewhere, that citation is still found and proposed
 *   - each candidate carries the FULL citing line, not just the hook —
 *     DevGuru's practical note: a reviewer shouldn't have to open the
 *     destination file to judge a proposal
 *   - applyTrimCandidates only rewrites rows for keys explicitly present
 *     in the given candidate list — a row that WAS a valid candidate but
 *     wasn't included in what's passed to applyTrimCandidates is left
 *     completely untouched (this is the propose/apply split itself: a
 *     candidate the caller doesn't pass through is never written)
 *   - idempotence: a row already rewritten to a pointer is never
 *     re-proposed, and a second consecutive full apply is a byte-identical
 *     no-op
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
  findTrimCandidates,
  applyTrimCandidates,
  trimPromotedRows,
  verifyTrimStats,
  type DestinationFile,
} from "./lib/mem-registry-trim-core.js";
import { isReliableHook } from "./lib/citation-detect.js";

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
      "### NIKDY žádný krok způsobující ztrátu dat",
      "",
      "- **NIKDY žádný krok způsobující ztrátu dat** — data-loss-step rule text. [MEM-99]",
      "",
      "### Bounded-field rule",
      "",
      "- **bounded-field rule** — cap every new field you add. [MEM-93/94/122]",
      "",
      "### Correction lesson",
      "",
      "- **[MEM-172] correction:** the suspicious thing was a false positive ([MEM-166]).",
      "- **[MEM-172] dedicated recap:** the monitoring pipeline is confirmed working end-to-end.",
    ].join("\n"),
  },
];

// --- findTrimCandidates: read-only proposal -------------------------------
const found = findTrimCandidates(REGISTRY, DESTINATIONS);

assert(found.totalDataRows === 7, "should find 7 data rows");
assert(found.alreadyPointer === 0, "no rows are pointers yet on a fresh registry");
assert(
  found.candidates.length === 2,
  "only MEM-99 (clean single-key) and MEM-172 (has its own dedicated single-key line) are proposed"
);
assert(
  found.candidates.map((c) => c.key).join(",") === "MEM-99,MEM-172",
  "proposed exactly the correct keys, sorted numerically"
);

const mem99 = found.candidates.find((c) => c.key === "MEM-99")!;
assert(mem99.file === "core/LEARNINGS.md" && mem99.line === 3, "MEM-99 candidate points at the right file:line");
assert(
  mem99.lineText.includes("NIKDY žádný krok způsobující ztrátu dat"),
  "MEM-99 candidate carries the FULL citing line, not just the hook — reviewer shouldn't need to open the destination file"
);
assert(
  mem99.hook === "NIKDY žádný krok způsobující ztrátu dat",
  "MEM-99 hook extracted from its governing heading, not the citing line's bold span"
);

const mem172 = found.candidates.find((c) => c.key === "MEM-172")!;
assert(
  mem172.line === 12 && mem172.lineText.includes("dedicated recap"),
  "MEM-172 candidate uses its OWN single-key line (line 12), not the ambiguous shared line (line 11) — scan-past-rejection"
);
assert(mem172.hook === "Correction lesson", "MEM-172 hook extracted from its governing heading");

// --- applyTrimCandidates: only rewrites rows explicitly passed in --------
// Approve ONLY MEM-99 — MEM-172, despite being a valid candidate, must stay untouched.
const partial = applyTrimCandidates(REGISTRY, [mem99]);
const cPartial = verifyTrimStats(partial.stats);
assert(partial.stats.trimmedRows === 1 && partial.stats.trimmedKeys.join(",") === "MEM-99", "only the approved candidate is applied");
assert(
  /\| MEM-172 \| ACTIVE \| 2026-07-30 \| — \|/.test(partial.registry),
  "MEM-172 (a valid but NOT approved candidate) is left completely untouched — propose/apply split"
);
assert(cPartial.length === 3, "all 3 verify checks passed");

// --- applyTrimCandidates: approve everything found -----------------------
const r1 = applyTrimCandidates(REGISTRY, found.candidates);
verifyTrimStats(r1.stats);
assert(r1.stats.trimmedRows === 2, "both proposed candidates applied when both are approved");

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
// Pointer rows carry file:line in Obsoleted, "see file — hook" in Description.
assert(
  /\| MEM-99 \| ACTIVE \| 2026-07-28 \| core\/LEARNINGS\.md:3 \| see core\/LEARNINGS\.md — NIKDY žádný krok způsobující ztrátu dat \|/.test(
    r1.registry
  ),
  "MEM-99 rewritten to a pointer with correct file:line and hook"
);
assert(
  /\| MEM-172 \| ACTIVE \| 2026-07-30 \| core\/LEARNINGS\.md:12 \| see core\/LEARNINGS\.md — Correction lesson \|/.test(
    r1.registry
  ),
  "MEM-172 trimmed using its OWN single-key line (line 12)"
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

// --- idempotence via the trimPromotedRows convenience wrapper ------------
const wrapped = trimPromotedRows(REGISTRY, DESTINATIONS);
assert(wrapped.registry === r1.registry, "trimPromotedRows == findTrimCandidates + applyTrimCandidates(all)");

const found2 = findTrimCandidates(r1.registry, DESTINATIONS);
assert(found2.candidates.length === 0, "re-scanning the trimmed registry proposes nothing new");
assert(found2.alreadyPointer === 2, "run 2 finds both trimmed rows as already-pointers");

const r2 = applyTrimCandidates(r1.registry, found2.candidates);
verifyTrimStats(r2.stats);
assert(r2.registry === r1.registry, "a second apply pass is byte-identical (idempotent)");

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

// --- index/pointer-shaped destination lines are rejected as evidence -----
// Live production catch (2026-08-12, DevGuru): today's consolidation run
// proposed 10 candidates off semantic/kb-promotion-provenance.md, an
// MEM-key → destination lookup table (one single-key line per row) — all
// 10 rejected on review. An index row isn't condensed narrative, it's a
// pointer elsewhere; citation-detect.ts now rejects lines shaped like a
// lookup/index row (`→ see`, `see …md`, or a `| MEM-N | ... |` table row),
// shared with mem-learnings-trim-core.ts (poller-brain#300).
const INDEX_REGISTRY = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-201 | ACTIVE | 2026-08-12 | — | should NOT be trimmed off an index row |
`;
const INDEX_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/kb-index.md",
    text: [
      "| Key | Destination |",
      "|-----|-------------|",
      "| MEM-201 | see semantic/other.md — some hook |",
    ].join("\n"),
  },
];
const indexFound = findTrimCandidates(INDEX_REGISTRY, INDEX_DESTINATIONS);
assert(
  indexFound.candidates.length === 0,
  "an index/lookup-table row citing exactly one key is NOT treated as narrative evidence — it's a pointer, not condensed content"
);
assert(
  indexFound.indexRejections.length === 1 &&
    indexFound.indexRejections[0].key === "MEM-201" &&
    indexFound.indexRejections[0].file === "semantic/kb-index.md",
  "the index row rejection is reported (not silently dropped) — DevGuru review round 2: coverage loss must never be silent"
);

// --- generalized index-shape detection (round 2): not just literal `kb/`
// paths or a `| MEM-N |` first cell — any markdown table row containing a
// path to another .md file is index-shaped, regardless of column layout.
const GENERALIZED_INDEX_REGISTRY = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-301 | ACTIVE | 2026-08-12 | — | should NOT be trimmed off a differently-shaped index row |
`;
const GENERALIZED_INDEX_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/other-index.md",
    text: [
      "| Destination | Key |",
      "|-------------|-----|",
      "| semantic/other.md | MEM-301 |",
    ].join("\n"),
  },
];
const generalizedIndexFound = findTrimCandidates(GENERALIZED_INDEX_REGISTRY, GENERALIZED_INDEX_DESTINATIONS);
assert(
  generalizedIndexFound.candidates.length === 0 && generalizedIndexFound.indexRejections.length === 1,
  "a table row is index-shaped by two cheap combined signals (table row + path to another .md file), not a hardcoded column layout"
);

// --- extractHook: the destination citation's governing heading is the
// ONLY hook source — no fallback to the citing line's bold spans or plain
// text (DevGuru catch, poller-brain#300 review round 4, live data on his
// own brain): round 3's "heading, else bold-scan, else plain text" design
// kept reproducing garbage in a new shape every round it was tested
// against real data — label bolds (`**How to apply:**`), then orphaned
// `**` markers, mid-sentence fragments, and bare citation parentheses. A
// heading is trustworthy by construction (it's the entry's own title) or
// it's absent, in which case the key is excluded via `unreliableHooks`
// rather than guessed at from prose.
const HOOK_REGISTRY = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-501 | ACTIVE | 2026-08-12 | — | Rule/Why/How-to-apply block, blank-line-separated from its heading — must still resolve to the heading, not "How to apply:" |
| MEM-502 | ACTIVE | 2026-08-12 | — | no heading anywhere above it in its destination file — must be excluded, not proposed with a garbage hook |
| MEM-503 | ACTIVE | 2026-08-12 | — | unrelated paragraph inside MEM-501's heading section, no heading of its own — inherits that heading (accepted trade-off: imprecise, never garbage) |
`;
const HOOK_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/hook-shapes.md",
    text: [
      "### Tag PR author at review end",
      "",
      "**Rule:** always tag the PR author when review concludes.",
      "",
      "**Why:** review comments otherwise go unseen.",
      "",
      "**How to apply:** mention them explicitly in the closing comment. [MEM-501]",
      "",
      "Some unrelated intro paragraph, no heading of its own, still under the same section. [MEM-503]",
    ].join("\n"),
  },
  {
    file: "semantic/no-heading.md",
    text: [
      "Plain narrative with no heading anywhere in this file.",
      '> MEM-502). This supersedes the older "no upstream tracking" behavior from before the fix.',
    ].join("\n"),
  },
];
const hookFound = findTrimCandidates(HOOK_REGISTRY, HOOK_DESTINATIONS);

const mem501 = hookFound.candidates.find((c) => c.key === "MEM-501");
assert(
  mem501?.hook === "Tag PR author at review end",
  `MEM-501 hook comes from its governing heading across blank lines, not the citing line's "**How to apply:**" bold — got "${mem501?.hook}"`
);

const mem503 = hookFound.candidates.find((c) => c.key === "MEM-503");
assert(
  mem503?.hook === "Tag PR author at review end",
  "MEM-503 (unrelated paragraph, no heading of its own) inherits the nearest heading above it — accepted trade-off, never garbage"
);

assert(
  !hookFound.candidates.some((c) => c.key === "MEM-502"),
  "MEM-502 (no heading anywhere in its file) is NOT proposed — no fallback to prose"
);
assert(
  hookFound.unreliableHooks.length === 1 &&
    hookFound.unreliableHooks[0].key === "MEM-502" &&
    hookFound.unreliableHooks[0].hook === "(no governing heading)",
  "MEM-502's exclusion is reported via unreliableHooks (not silently dropped)"
);

// isReliableHook: each check below traces to a real garbage hook DevGuru
// found live on his own brain in review round 4 — all four would have
// passed round 3's length + `>`/`|`-start-only guard.
assert(!isReliableHook("(MEM-95, 2026-07-24.)"), "bare citation parenthesis rejected — zero description content");
assert(
  !isReliableHook("2026-08-02 (MEM-115):** caught under-applying this — a low-risk,"),
  "orphaned ** marker rejected — a leaked bold delimiter, not real content"
);
assert(
  !isReliableHook("around. (MEM-124, 2026-08-07; same detection-risk family as the"),
  "lowercase mid-sentence start rejected — not a title"
);
assert(
  !isReliableHook("transparently in-thread and loop the owner in rather"),
  "lowercase mid-sentence start rejected — not a title"
);
assert(isReliableHook("Tag PR author at review end"), "a real heading passes the guard");

console.log(`✅ all ${passed} assertions passed`);
