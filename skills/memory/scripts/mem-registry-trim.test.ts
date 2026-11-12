#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the MEM_REGISTRY promoted-row trim logic.
 *
 * Runs the count-verify conditions against string fixtures (no fs):
 *   - findTrimCandidates is read-only and never mutates the registry
 *   - promotion gate: a candidate is proposed only if its key has a
 *     genuine single-key citation in a destination file
 *   - multi-key-line rejection: a line citing 2+ distinct MEM-N keys is
 *     never proposed as evidence for ANY of them UNLESS one of them sits in
 *     leading subject position (poller-brain#334) — a bare compact cluster
 *     (`MEM-93/94/122`) or a line whose leading text isn't a MEM-N tag at
 *     all stays rejected for every key it mentions
 *   - subject-position acceptance (poller-brain#334): a line like
 *     `[MEM-172] ... ([MEM-166])` DOES count as evidence for the leading
 *     key (MEM-172), even though MEM-166 is also mentioned — MEM-166 itself
 *     still gets no evidence from that line, since it isn't the subject
 *   - scan-past-rejection: if a key has no leading-subject citation on the
 *     first line it appears on, but has a genuine single-key (or subject-
 *     position) citation elsewhere, that later citation is still found
 *   - priority-order (DevGuru catch, poller-brain#334 review round 1):
 *     `firstCitations` keeps the FIRST non-ambiguous evidence in scan order,
 *     full stop — it does not prefer a single-key line over a subject-
 *     position line. So when a key has BOTH an earlier subject-position
 *     line (2-key, now newly-qualified by #334) AND a later dedicated
 *     single-key line, resolution now points at the EARLIER subject-
 *     position line, even though pre-#334 code would have resolved to the
 *     later dedicated line (the earlier line used to be skipped outright).
 *     This is the SAME "first found wins" invariant scan-past-rejection
 *     already relies on — not a new rule, just #334 extending which lines
 *     count as non-ambiguous — but it does mean already-correctly-trimming
 *     keys can silently point at different destination text after this
 *     ships. Verified deliberately, not accidentally, below.
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
 * Exits non-zero if any assertion fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  findTrimCandidates,
  applyTrimCandidates,
  trimPromotedRows,
  verifyTrimStats,
  type DestinationFile,
} from "./lib/mem-registry-trim-core.js";
import { isReliableHook } from "./lib/citation-detect.js";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    failed++;
    return;
  }
  passed++;
}

// A fixture mirroring the real registry shape: one clean single-key match,
// one compact multi-key cluster (all 3 keys must be rejected), one pair
// cited together via separate bracket tags on one line where the FIRST key
// is the line's subject (MEM-334 subject-position acceptance), one pair
// cited together on a line with NO leading MEM-N tag at all (still fully
// ambiguous, but one of the two also has its own dedicated line elsewhere
// — scan-past-rejection), and one row never cited anywhere.
const REGISTRY = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-99 | ACTIVE | 2026-07-28 | — | full narrative about the data-loss-step rule, already promoted verbatim into LEARNINGS.md |
| MEM-93 | ACTIVE | 2026-07-28 | — | full narrative about the bounded-field rule — only ever cited as part of a 3-key family cluster |
| MEM-94 | ACTIVE | 2026-07-28 | — | second half of the same 3-key family cluster — never cited alone anywhere |
| MEM-122 | ACTIVE | 2026-07-28 | — | third of the same 3-key family cluster — never cited alone anywhere |
| MEM-166 | ACTIVE | 2026-07-30 | — | live investigation narrative — only ever mentioned in passing on a line whose real subject is MEM-172 |
| MEM-172 | ACTIVE | 2026-07-30 | — | correction narrative — its destination line's SUBJECT, even though MEM-166 is also mentioned on the same line |
| MEM-200 | ACTIVE | 2026-07-28 | — | full narrative that has never been promoted anywhere — must stay untouched |
| MEM-210 | ACTIVE | 2026-08-19 | — | root-cause narrative — first mentioned on an ambiguous no-subject line, has its own dedicated single-key line elsewhere |
| MEM-211 | ACTIVE | 2026-08-19 | — | co-mentioned only on the same ambiguous no-subject line as MEM-210 — never cited alone anywhere |
| MEM-230 | ACTIVE | 2026-08-20 | — | has BOTH an earlier subject-position line AND a later dedicated single-key line — priority-order check (DevGuru, poller-brain#334) |
| MEM-231 | ACTIVE | 2026-08-20 | — | co-mentioned only on MEM-230's earlier subject-position line — never cited alone anywhere |
| MEM-240 | ACTIVE | 2026-08-20 | — | first mentioned in a leading RUN of three separate tags (still ambiguous), has its own dedicated single-key line elsewhere — leading-run-of-tags check (DevGuru, poller-brain#334 review round one, blocking one) |
| MEM-241 | ACTIVE | 2026-08-20 | — | co-mentioned only in the leading run-of-tags line with MEM-240 and MEM-242 — never cited alone anywhere |
| MEM-242 | ACTIVE | 2026-08-20 | — | co-mentioned only in the leading run-of-tags line with MEM-240 and MEM-241 — never cited alone anywhere |
| MEM-250 | ACTIVE | 2026-08-20 | — | subject of a leading tag on a line that ALSO contains wikilink cross-refs (index-shaped, excluded), has its own dedicated single-key line elsewhere — wikilink cross-ref check (DevGuru, poller-brain#334 review round one, to-fix two) |
| MEM-251 | ACTIVE | 2026-08-20 | — | co-mentioned only mid-sentence on MEM-250's wikilink cross-ref line — never cited alone anywhere |
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
      "",
      "### Scan-past-still-needed lesson",
      "",
      "- **Investigation notes:** flagged per MEM-210 and MEM-211 jointly, cause still unclear.",
      "- **[MEM-210] confirmed root cause:** isolated and fixed.",
      "",
      "### Priority-order check (earlier subject-position line vs later dedicated line)",
      "",
      "- **[MEM-230] shared context:** touches on MEM-231 in passing, but MEM-230 is the subject.",
      "- **[MEM-230] dedicated recap:** a later, fully single-key restatement of the same lesson.",
      "",
      "### Run-of-tags check (leading RUN of separate tags stays ambiguous for ALL of them)",
      "",
      "- [MEM-240] [MEM-241] [MEM-242] — three co-equal subjects mentioned together, none is the sole subject.",
      "",
      "### Run-of-tags dedicated recap (only reachable via scan-past)",
      "",
      "- **[MEM-240] dedicated:** own single-key line, found via scan-past.",
      "",
      "### Wikilink cross-refs (index-shaped, must be excluded from evidence)",
      "",
      "- [MEM-250] [[iam-quota-strategy]] · [MEM-251] (this mechanism) · [[poller-error-reporting]]",
      "",
      "### Wikilink dedicated recap (only reachable via scan-past, since the wikilink line is index-shaped)",
      "",
      "- **[MEM-250] dedicated:** own single-key line, found via scan-past past the wikilink line.",
      // Citation-selection fixtures preserve the complete entry bodies too.
      "Fixture details: " + REGISTRY.split("\n").filter((line) =>
        /^\| MEM-(?:99|172|210|230|240|250) \|/.test(line))
        .map((line) => line.split("|").slice(5, -1).join("|").trim()).join("; "),
    ].join("\n"),
  },
];

// --- findTrimCandidates: read-only proposal -------------------------------
const found = findTrimCandidates(REGISTRY, DESTINATIONS);

assert(found.totalDataRows === 16, "should find 16 data rows");
assert(found.alreadyPointer === 0, "no rows are pointers yet on a fresh registry");
assert(
  found.candidates.length === 6,
  "MEM-99 (clean single-key), MEM-172 (subject-position on a 2-key line), MEM-210 (scan-past to its own dedicated line), MEM-230 (earlier subject-position line, priority-order check), MEM-240 (leading run-of-tags stays ambiguous, scan-past to its dedicated line), and MEM-250 (wikilink cross-ref line excluded as index-shaped, scan-past to its dedicated line) are proposed"
);
assert(
  found.candidates.map((c) => c.key).join(",") === "MEM-99,MEM-172,MEM-210,MEM-230,MEM-240,MEM-250",
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
  mem172.line === 11 && mem172.lineText.includes("correction"),
  "MEM-172 candidate uses the FIRST line it's the subject of (line 11), even though that line also mentions MEM-166 — subject-position acceptance (poller-brain#334)"
);
assert(mem172.hook === "Correction lesson", "MEM-172 hook extracted from its governing heading");

const mem210 = found.candidates.find((c) => c.key === "MEM-210")!;
assert(
  mem210.line === 17 && mem210.lineText.includes("confirmed root cause"),
  "MEM-210 candidate uses its OWN dedicated single-key line (line 17), not the earlier ambiguous no-subject line (line 16) — scan-past-rejection still works alongside subject-position"
);
assert(mem210.hook === "Scan-past-still-needed lesson", "MEM-210 hook extracted from its governing heading");

// DevGuru catch (poller-brain#334 review round 1): MEM-230 has BOTH an
// earlier 2-key subject-position line (line 21, newly-qualified by #334)
// AND a later dedicated single-key line (line 22). `firstCitations` keeps
// the FIRST non-ambiguous evidence in scan order — so resolution now points
// at the EARLIER subject-position line, not the later dedicated one. Before
// #334, the earlier line was skipped outright (2 keys, no subject-position
// concept existed), so the later dedicated line would have won instead —
// this selection change for an already-correctly-trimming key is real,
// verified here deliberately rather than left as a silent side effect.
const mem230 = found.candidates.find((c) => c.key === "MEM-230")!;
assert(
  mem230.line === 21 && mem230.lineText.includes("shared context"),
  "MEM-230 candidate uses the EARLIER subject-position line (line 21), superseding the LATER dedicated single-key line (line 22) — priority-order is 'first found in scan order', not 'prefer single-key over subject-position' (DevGuru, poller-brain#334)"
);
assert(mem230.hook === "Priority-order check (earlier subject-position line vs later dedicated line)", "MEM-230 hook extracted from its governing heading");

// DevGuru catch (poller-brain#334 review round 1, BLOCKING 1): the original
// `SUBJECT_TAG_RE` captured only the FIRST tag of a leading RUN, so a real
// shape like `[MEM-167]/[MEM-170]/[MEM-171]: ...` silently picked the first
// key as the sole "subject" instead of staying ambiguous — measured live,
// 4 real occurrences across 3 brains, one of which (MEM-355) demoted a key
// from its own dedicated heading to a shared bookkeeping line. The fixed
// regex captures the WHOLE leading run and requires it to name exactly one
// distinct key — a genuine run of co-equal tags now correctly stays
// rejected (same ambiguity class as `[MEM-93/94/122]`), and a key with such
// a run AND its own dedicated line elsewhere is still found via scan-past.
const mem240 = found.candidates.find((c) => c.key === "MEM-240")!;
assert(
  mem240.line === 30 && mem240.lineText.includes("dedicated"),
  "MEM-240 candidate uses its OWN dedicated single-key line (line 30), NOT the earlier leading-run-of-3-tags line (line 26) — the run stays ambiguous, scan-past still works (DevGuru, poller-brain#334 blocking 1)"
);
assert(mem240.hook === "Run-of-tags dedicated recap (only reachable via scan-past)", "MEM-240 hook extracted from its governing heading");
assert(
  !found.candidates.some((c) => c.key === "MEM-241" || c.key === "MEM-242"),
  "MEM-241/MEM-242 (only ever co-mentioned in the leading run-of-tags line) are NOT proposed — the whole run stays ambiguous, not just 'first key wins'"
);

// DevGuru catch (poller-brain#334 review round 1, TO-FIX 2): subject-
// position widened evidence into a "Cross-refs"-style bullet listing
// several `[[wikilink]]` targets alongside citations — a pointer to
// elsewhere, same as an `.md` path, just bracket syntax. `isIndexShapedLine`
// now also recognizes a `[[wikilink]]` token and excludes such a line from
// evidence (reported via indexRejections, never silently dropped) — the key
// is still found via its own dedicated line elsewhere (scan-past).
const mem250 = found.candidates.find((c) => c.key === "MEM-250")!;
assert(
  mem250.line === 38 && mem250.lineText.includes("dedicated"),
  "MEM-250 candidate uses its OWN dedicated single-key line (line 38), NOT the earlier wikilink cross-ref line (line 34, index-shaped) — scan-past still works past a wikilink line (DevGuru, poller-brain#334 to-fix 2)"
);
assert(
  found.indexRejections.some((r) => r.key === "MEM-250" && r.line === 34 && r.lineText.includes("iam-quota-strategy")),
  "the wikilink cross-ref line is reported via indexRejections, not silently dropped"
);
assert(
  !found.candidates.some((c) => c.key === "MEM-251"),
  "MEM-251 (only ever mid-sentence on MEM-250's wikilink cross-ref line) is NOT proposed"
);

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
assert(r1.stats.trimmedRows === 6, "all six proposed candidates applied when all are approved");

// Multi-key cluster line: none of the 3 family keys are trusted as evidence.
for (const key of ["MEM-93", "MEM-94", "MEM-122"]) {
  assert(
    new RegExp(`\\| ${key} \\| ACTIVE \\| 2026-07-28 \\| — \\|`).test(r1.registry),
    `${key} (only cited in the 3-key family cluster) stays untouched — multi-key-line rejection`
  );
}
// MEM-166 was only ever a non-subject mention on MEM-172's line — no evidence, stays untouched.
assert(
  /\| MEM-166 \| ACTIVE \| 2026-07-30 \| — \|/.test(r1.registry),
  "MEM-166 (only ever a non-subject mention on MEM-172's line) stays untouched"
);
// MEM-211 was only ever a non-subject mention on MEM-210's ambiguous no-subject line — no evidence, stays untouched.
assert(
  /\| MEM-211 \| ACTIVE \| 2026-08-19 \| — \|/.test(r1.registry),
  "MEM-211 (only ever co-mentioned on MEM-210's ambiguous no-subject line) stays untouched"
);
// MEM-231 was only ever a non-subject mention on MEM-230's earlier subject-position line — no evidence, stays untouched.
assert(
  /\| MEM-231 \| ACTIVE \| 2026-08-20 \| — \|/.test(r1.registry),
  "MEM-231 (only ever co-mentioned on MEM-230's subject-position line) stays untouched"
);
// MEM-241/MEM-242 were only ever co-mentioned in the leading run-of-tags line — no evidence, stay untouched.
for (const key of ["MEM-241", "MEM-242"]) {
  assert(
    new RegExp(`\\| ${key} \\| ACTIVE \\| 2026-08-20 \\| — \\|`).test(r1.registry),
    `${key} (only ever co-mentioned in the leading run-of-tags line) stays untouched`
  );
}
// MEM-251 was only ever mid-sentence on MEM-250's wikilink cross-ref line — no evidence, stays untouched.
assert(
  /\| MEM-251 \| ACTIVE \| 2026-08-20 \| — \|/.test(r1.registry),
  "MEM-251 (only ever mid-sentence on MEM-250's wikilink cross-ref line) stays untouched"
);
// Pointer rows carry file:line in Obsoleted, "see file — hook" in Description.
assert(
  /\| MEM-99 \| ACTIVE \| 2026-07-28 \| core\/LEARNINGS\.md:3 \| see core\/LEARNINGS\.md — NIKDY žádný krok způsobující ztrátu dat \|/.test(
    r1.registry
  ),
  "MEM-99 rewritten to a pointer with correct file:line and hook"
);
assert(
  /\| MEM-172 \| ACTIVE \| 2026-07-30 \| core\/LEARNINGS\.md:11 \| see core\/LEARNINGS\.md — Correction lesson \|/.test(
    r1.registry
  ),
  "MEM-172 trimmed using its subject-position line (line 11), the first line it's the subject of"
);
assert(
  /\| MEM-210 \| ACTIVE \| 2026-08-19 \| core\/LEARNINGS\.md:17 \| see core\/LEARNINGS\.md — Scan-past-still-needed lesson \|/.test(
    r1.registry
  ),
  "MEM-210 trimmed using its OWN dedicated single-key line (line 17), found via scan-past-rejection"
);
assert(
  /\| MEM-230 \| ACTIVE \| 2026-08-20 \| core\/LEARNINGS\.md:21 \| see core\/LEARNINGS\.md — Priority-order check \(earlier subject-position line vs later dedicated line\) \|/.test(
    r1.registry
  ),
  "MEM-230 trimmed using its EARLIER subject-position line (line 21), not the later dedicated line (line 22) — priority-order (DevGuru, poller-brain#334)"
);
assert(
  /\| MEM-240 \| ACTIVE \| 2026-08-20 \| core\/LEARNINGS\.md:30 \| see core\/LEARNINGS\.md — Run-of-tags dedicated recap \(only reachable via scan-past\) \|/.test(
    r1.registry
  ),
  "MEM-240 trimmed using its dedicated line (line 30), found via scan-past past the ambiguous leading-run-of-tags line"
);
assert(
  /\| MEM-250 \| ACTIVE \| 2026-08-20 \| core\/LEARNINGS\.md:38 \| see core\/LEARNINGS\.md — Wikilink dedicated recap \(only reachable via scan-past, since the wikilink line is index-shaped\) \|/.test(
    r1.registry
  ),
  "MEM-250 trimmed using its dedicated line (line 38), found via scan-past past the wikilink cross-ref line"
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
assert(found2.alreadyPointer === 6, "run 2 finds all six trimmed rows as already-pointers");

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
      "Fixture details: " + HOOK_REGISTRY.split("\n").filter((line) => /^\| MEM-(?:501|503) \|/.test(line))
        .map((line) => line.split("|").slice(5, -1).join("|").trim()).join("; "),
    ].join("\n"),
  },
  {
    file: "semantic/no-heading.md",
    text: [
      "Plain narrative with no heading anywhere in this file.",
      '> MEM-502). This supersedes the older "no upstream tracking" behavior from before the fix.',
      "no heading anywhere above it in its destination file — must be excluded, not proposed with a garbage hook",
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

// Full identities drive proposal, ordering, hook stripping and exact --only selection.
const DATED_A = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DATED_B = "MEM-2026-11-07-203001-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";

const mixedRegistry = [DATED_B, "MEM-12", DATED_A].map((key) =>
  `| ${key} | ACTIVE | 2026-11-07 | — | ${"Full narrative retained until explicitly approved. ".repeat(12)} |`).join("\n");
const mixedDest = [{ file: "semantic/mixed.md", text: [
  `### [${DATED_A}] Keep dated identities intact [${DATED_A}:obsolete]`,
  `Full condensed narrative for the first memo. [${DATED_A}]`,
  `### Preserve the second memo separately [${DATED_B}]`,
  `Full condensed narrative for the second memo. [${DATED_B}]`,
  "### Preserve the existing legacy memo [MEM-12]",
  "Full condensed narrative for the legacy memo. [MEM-12]",
  "Full narrative retained until explicitly approved. ".repeat(12),
].join("\n") }];
const mixedFound = findTrimCandidates(mixedRegistry, mixedDest);
assert(mixedFound.totalDataRows === 3, "registry parser counts mixed formats");
assert(mixedFound.candidates.map((c) => c.key).join(",") === ["MEM-12", DATED_A, DATED_B].join(","), "dated candidates remain distinct and sorted");
assert(mixedFound.candidates.find((c) => c.key === DATED_A)?.hook === "Keep dated identities intact", "dated leading/trailing lifecycle tags strip completely");
const mixedApplied = applyTrimCandidates(mixedRegistry, mixedFound.candidates.filter((c) => c.key === DATED_B));
assert(mixedApplied.stats.trimmedKeys.join(",") === DATED_B, "exact dated key selects one rewrite");
assert(mixedApplied.registry.includes(`| ${DATED_A} | ACTIVE | 2026-11-07 | — | Full narrative`), "unselected same-year dated row stays untouched");
const trimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-id-registry-"));
try {
  fs.mkdirSync(path.join(trimRoot, "memory/semantic"), { recursive: true });
  fs.writeFileSync(path.join(trimRoot, "CLAUDE.md"), "fixture");
  fs.writeFileSync(path.join(trimRoot, "memory/MEM_REGISTRY.md"), mixedRegistry);
  fs.writeFileSync(path.join(trimRoot, "memory/semantic/mixed.md"), mixedDest[0].text);
  const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-registry-trim.ts"), "--apply", "--only", DATED_B],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: trimRoot } });
  assert(cli.status === 0, `registry --only dated ID finds candidate: ${cli.stderr}`);
  const written = fs.readFileSync(path.join(trimRoot, "memory/MEM_REGISTRY.md"), "utf8");
  assert(written.includes(`| ${DATED_B} | ACTIVE | 2026-11-07 | semantic/mixed.md:`), "CLI rewrites dated selected row");
  assert(written.includes(`| ${DATED_A} | ACTIVE | 2026-11-07 | — | Full narrative`), "CLI preserves unselected dated row");
} finally {
  fs.rmSync(trimRoot, { recursive: true, force: true });
}

// #505: a citation alone must not discard the only copy of a URL or filename.
const coverageRegistry = [
  "| MEM-601 | ACTIVE | 2026-11-12 | — | Read https://example.org/Questions2017 and questions.xlsx before answering. |",
  "| MEM-602 | ACTIVE | 2026-11-12 | — | Read https://example.org/Questions2017 and questions.xlsx before answering. |",
  "| MEM-603 | ACTIVE | 2026-11-12 | — | Always preserve the original facts before condensing the prose. |",
].join("\n");
const coverageDestinations: DestinationFile[] = [
  { file: "semantic/missing.md", text: "### Official question procedure\nThe procedure is documented here. [MEM-601]" },
  { file: "semantic/covered.md", text: "### Official question procedure\nRead https://example.org/Questions2017 and questions.xlsx before answering. [MEM-602]" },
  { file: "semantic/plain.md", text: "### Preserve original facts\nPreserve the facts before condensing. [MEM-603]" },
];
const coverageFound = findTrimCandidates(coverageRegistry, coverageDestinations);
assert(!coverageFound.candidates.some((c) => c.key === "MEM-601"), "#505: missing URL/filename rejects the row instead of proposing a pointer");
const missingCoverage = coverageFound.contentCoverage?.find((c) => c.key === "MEM-601");
assert(missingCoverage?.status === "rejected" &&
  JSON.stringify(missingCoverage.missingTokens) === JSON.stringify(["no-literal-match"]),
  "#505: rejected row reports one machine-readable no-literal-match reason");
assert(coverageFound.candidates.some((c) => c.key === "MEM-602"), "#505: fully covered row is still proposed");
assert(coverageFound.contentCoverage?.find((c) => c.key === "MEM-602")?.status === "covered", "#505: covered row reports successful coverage");
// fail closed: literal containment only (#505 redesign)
assert(!coverageFound.candidates.some((c) => c.key === "MEM-603"), "#505: a paraphrase without distinctive tokens is rejected");
const noTokens = coverageFound.contentCoverage?.find((c) => c.key === "MEM-603");
// fail closed: literal containment only (#505 redesign)
assert(noTokens?.status === "rejected" && noTokens.tokens.length === 0 && noTokens.missingTokens.join() === "no-literal-match",
  "#505: prose requires the same literal evidence as technical details");

function inspectCoverage(description: string, destination: string) {
  return findTrimCandidates(`| MEM-604 | ACTIVE | 2026-11-12 | — | ${description} |`, [{
    file: "semantic/details.md",
    text: `### Verified literal content coverage\nCondensed lesson. [MEM-604]\n${destination}`,
  }]).contentCoverage[0];
}
const richDescription = "Read [source](https://example.org/Case_(2017)?q=Yes). Keep src/parser.ts, C:\\data\\facts.csv, /tmp, questions.xlsx, .xls, .xlsx, `parseRecord`, `queue   Job`, 2015, 1.25, 42ms, 2 GB, BIFF and TASK_ID-7. Keep small counts 12 and 7.";
const richCoverage = inspectCoverage(richDescription,
  "https://example.org/Case_(2017)?q=Yes\nSRC/PARSER.TS c:\\DATA\\facts.csv /tmp QUESTIONS.XLSX .xls .xlsx parserecord queue\n job; 2015; 1.25; 42 MS; 2gb; biff task_id-7; counts 12 and 7");
assert(richCoverage.tokens.length === 0, "#505: legacy tokens field stays empty");
assert(inspectCoverage(richDescription, richDescription).status === "covered", "#505: the same URLs, Markdown and details are covered literally");
// fail closed: literal containment only (#505 redesign)
assert(richCoverage.status === "rejected", "#505: a reordered tokens-only destination is rejected");
assert(inspectCoverage("Read https://example.org/Source", "https://example.org/source").status === "rejected", "#505: URL case stays exact");
assert(inspectCoverage("Read https://example.org/source", "https://example.org/source-old").status === "rejected", "#505: a longer URL does not cover a shorter URL");
assert(inspectCoverage("Read https://example.org/source and facts.csv", "https://example.org/source").missingTokens.join() === "no-literal-match",
  "#505: partial coverage reports no-literal-match");
// fail closed: literal containment only (#505 redesign)
assert(inspectCoverage("Keep s3://Bucket/Case and HTTPS://example.org/Case", "s3://Bucket/Case HTTPS://example.org/Case").status === "rejected", "#505: URL tokens alone do not preserve the entry");
// fail closed: literal containment only (#505 redesign)
assert(inspectCoverage("Keep -12.5°C, .5kg and +123", "-12.5 °c .5 kg +123").status === "rejected", "#505: case and unit spacing stay exact");
assert(inspectCoverage("Keep questions.xlsx, `parseRecord`, 123 and API", "questions.xlsx.bak parseRecords 1234 APIS").status === "rejected",
  "#505: fragments cannot cover filenames, identifiers, numbers and caps IDs");
assert(inspectCoverage("Keep `curl https://example.org/Source` then `parseRecord`", "https://example.org/source parseRecord").status === "rejected",
  "#505: URLs inside inline code remain exact, and adjacent code spans stay separate");
const duplicates = inspectCoverage("Keep `parseRecord` and `PARSERECORD` with 123 and 123", "parseRecord 123");
assert(duplicates.status === "rejected" && duplicates.tokens.length === 0, "#505: repeated fragments cannot replace the body");

// Review1 finding 1: preserve complete URL and Markdown spellings.
for (const suffix of [".", "!", "?", ",", ";", ":", "**", "__", "_(part)."]) {
  const url = `https://example.org/export${suffix}`;
  for (const source of [`[source](${url})`, `\`${url}\``, `<${url}>`, `\`curl ${url}\``]) {
    const preserved = inspectCoverage(source, `[copy](${url})`);
    // fail closed: literal containment only (#505 redesign)
    assert(preserved.status === "rejected",
      `#505 review1 URL: explicit boundary preserves ${source}`);
    assert(inspectCoverage(source, "https://example.org/export").status === "rejected",
      `#505 review1 URL: dropping literal suffix rejects ${source}`);
    assert(inspectCoverage("https://example.org/export", source).status === "rejected",
      `#505 review1 URL: adding literal suffix rejects ${source}`);
  }
}
for (const decorated of ["https://example.org/export.", "https://example.org/export!", "https://example.org/export?",
  "**https://example.org/export**", "__https://example.org/export__", "**https://example.org/export!**", "(https://example.org/export). "]) {
  // fail closed: literal containment only (#505 redesign)
  assert(inspectCoverage(decorated, "https://example.org/export").status ===
    (decorated === "https://example.org/export." ? "covered" : "rejected"),
    `#505 review1 URL: only a trailing sentence period folds in ${decorated}`);
  assert(inspectCoverage("https://example.org/export", decorated).status === "covered",
    `#505 review1 URL: strip surrounding prose/Markdown from destination ${decorated}`);
}
// fail closed: literal containment only (#505 redesign)
assert(inspectCoverage('[source](https://example.org/export. "Export title")', "`https://example.org/export.`").status === "rejected",
  "#505 review1 URL: a Markdown title does not turn a literal final dot into prose punctuation");
const adjacentLinks = inspectCoverage("[first](https://example.org/first.)[second](https://example.org/second.)",
  "`https://example.org/first.` `https://example.org/second.`");
// fail closed: literal containment only (#505 redesign)
assert(adjacentLinks.status === "rejected",
  "#505 review1 URL: one Markdown destination cannot swallow an adjacent link");

// Review1 finding 2: punctuation inside a number cannot delimit a match.
for (const larger of ["1234", "123,456", "123.456", "123,456,789", "123.456.789"]) {
  const coverage = inspectCoverage("Limit je 123.", `Limit je ${larger}.`);
  assert(coverage.status === "rejected" && coverage.missingTokens.join() === "no-literal-match",
    `#505 review1 numeric: 123 cannot match a prefix of ${larger}`);
}
assert(inspectCoverage("Limit je 456.", "Limit je 123,456.").status === "rejected",
  "#505 review1 numeric: a comma-separated numeric suffix is not a standalone amount");
assert(inspectCoverage("Limit je 123,456.", "Limit je 123,456,789.").status === "rejected",
  "#505 review1 numeric: a decimal token cannot match a prefix of a longer grouped number");
assert(inspectCoverage("Limit je 123.", "Limit je 123, celkem.").status === "covered",
  "#505 review1 numeric: ordinary sentence punctuation still delimits a number");

// Review1 finding 3: both composed letters and combining marks belong to
// filename/path segments, including Windows paths and non-ASCII extensions.
for (const filename of ["příručka.xlsx", "příručka.xlsx".normalize("NFD"), "návody/příručka.xlsx",
  "/návody/příručka.xlsx", "C:\\návody\\příručka.xlsx", "příručka.údaje"]) {
  const missing = inspectCoverage(`API používá ${filename}.`, "API používá dokument.");
  assert(missing.status === "rejected" && missing.missingTokens.join() === "no-literal-match",
    `#505 review1 Unicode filename: missing ${filename} rejects the row`);
  const preserved = inspectCoverage(`API používá ${filename}.`, `API používá ${filename}.`);
  assert(preserved.status === "covered" && preserved.tokens.length === 0,
    `#505 review1 Unicode filename: preserved ${filename} matches in full`);
}

// Review1 finding 4: the unit boundary after č must be Unicode-aware.
const czechAmount = inspectCoverage("API stojí 50 Kč.", "API stojí 80 Kč.");
assert(czechAmount.tokens.length === 0, "#505 review1 currency: no amount token extraction remains");
assert(czechAmount.status === "rejected" && czechAmount.missingTokens.join() === "no-literal-match",
  "#505 review1 currency: changing the Czech currency amount rejects the row");
// fail closed: literal containment only (#505 redesign)
assert(inspectCoverage("API stojí 50 Kč.", "API stojí 50kč.").status === "rejected",
  "#505 review1 currency: currency case and unit spacing remain literal");
assert(inspectCoverage("API stojí 50 Kčeských.", "API").status === "rejected",
  "#505 review1 currency: a unit prefix cannot replace the entry");

// #505 final iteration: review1 + verify corpus, with explicit expectations
// in BOTH directions (adding a missing filename is intentionally asymmetric).
type CoverageStatus = "covered" | "rejected";
type CoverageProbe = [group: string, label: string, source: string, destination: string,
  forward: CoverageStatus, reverse?: CoverageStatus];
const probeUrl = "https://example.org/export";
const coverageProbes: CoverageProbe[] = [
  ["verify2", "rate grouping", "API stojí 234 Kč/h.", "API stojí 1 234 Kč/h.", "rejected"],
  ["verify2", "NBSP rate grouping", "API stojí 234 Kč/h.", "API stojí 1\u00a0234 Kč/h.", "rejected"],
  ["verify2", "daily rate grouping", "API stojí 234 Kč/den.", "API stojí 1 234 Kč/den.", "rejected"],
  ["verify2", "filename plus suffix", "API používá příručka.xlsx.", "API používá příručka.xlsx+záloha.", "rejected"],
  ["verify2", "path tilde suffix", "API používá návody/příručka.xlsx.", "API používá návody/příručka.xlsx~záloha.", "rejected"],
  ["verify2", "Unicode minus", "API stojí −50 Kč.", "API stojí 50 Kč.", "rejected"],
  ["verify2", "changed addend", "API stojí 50+20 Kč.", "API stojí 50+80 Kč.", "rejected"],
  ["verify2", "dropped addend", "API stojí 50+20 Kč.", "API stojí 50.", "rejected"],
  ["verify2", "Czech comma dash currency", "API stojí 50,- Kč.", "API limit je 50.", "rejected"],
  ["verify2", "grouped Czech comma dash currency", "API stojí 1.234,- Kč.", "API limit je 1.234.", "rejected"],
  ["boundaries", "rate continuation", "API stojí 50 Kč", "API stojí 50 Kč/h", "rejected"],
  ["boundaries", "numeric addend", "50", "50+20", "rejected"],
  ["boundaries", "filename continuation", "xlsx", "xlsx+záloha", "rejected"],
  ["boundaries", "Unicode sign", "50", "−50", "rejected"],
  ["boundaries", "grouped numeric suffix", "234", "1 234", "rejected"],
  ["boundaries", "grouped numeric prefix", "1", "1 234", "rejected"],
  ["boundaries", "Czech amount continuation", "50", "50,- Kč", "rejected"],
  ["literal", "identical prose without technical tokens", "Petr bydlí v Brně a má rád zelený čaj.", "Petr bydlí v Brně a má rád zelený čaj.", "covered"],
  ["literal", "NFC", "API používá příručka.xlsx.".normalize("NFD"), "API používá příručka.xlsx.", "covered"],
  ["literal", "whitespace folding", "API stojí 1 234 Kč.", "API\tstojí 1\u202f234\u2009Kč", "covered"],
  ["literal", "trailing period", "API stojí 50 Kč.", "API stojí 50 Kč", "covered"],
  ["literal", "dash list marker", "- API stojí 50 Kč.", "API stojí 50 Kč", "covered"],
  ["literal", "asterisk list marker", "* API stojí 50 Kč.", "API stojí 50 Kč", "covered"],
  ["literal", "numbered list marker", "1. API stojí 50 Kč.", "API stojí 50 Kč", "covered"],
  ["literal", "case sensitive prose", "API stojí 50 Kč", "api stojí 50 Kč", "rejected"],
  ["literal", "literal Markdown", "Use **facts.csv**.", "Use **facts.csv**.", "covered"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "prose exclamation", `${probeUrl}!`, probeUrl, "rejected", "covered"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "bold", `**${probeUrl}**`, probeUrl, "rejected", "covered"],
  ["review1", "prose period", `${probeUrl}.`, probeUrl, "covered"],
  ["review1", "literal Markdown period", `[source](${probeUrl}.)`, `[copy](${probeUrl})`, "rejected"],
  ["review1", "literal code period", `\`${probeUrl}.\``, `\`${probeUrl}\``, "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "Markdown labels retain identifiers", `[MPO](${probeUrl})`, `[official source](${probeUrl})`, "rejected", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "balanced URL parentheses", "[source](https://example.org/Case_(2017)).", "https://example.org/Case_(2017)", "rejected", "covered"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "tokenless Czech prose", "Petr bydlí v Brně a má rád zelený čaj.", "Some unrelated content", "rejected"],
  ["review1", "Czech unit", "Cena je 50 Kč.", "Cena je 80 Kč.", "rejected"],
  ["review1", "decimal precision with unit", "Limit je 1,25 kg.", "Limit je 1,250 kg.", "rejected"],
  ["review1", "decimal precision", "Limit je 1,25.", "Limit je 1,250.", "rejected"],
  ["review1", "decimal comma magnitude", "Limit je 123.", "Limit je 123,456.", "rejected"],
  ["review1", "signed number", "Limit je 123.", "Limit je +123.", "rejected"],
  ["review1", "signed magnitude", "Limit je 123.", "Limit je +1234.", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "Unicode filename missing", "Použij příručka.xlsx.", "No source file", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "Unicode filename partial", "API používá příručka.xlsx.", "API používá jiný soubor.", "rejected"],
  ["review1", "Czech currency partial", "API stojí 50 Kč.", "API stojí 80 Kč.", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "semantic facts still require review", "API patří Petrovi z Brna.", "API patří Janovi z Prahy.", "rejected"],
  ["review1", "slash path", "Use foo/bar for the operation.", "Use foo/bar for the operation.", "covered"],
  ["review1", "comma without whitespace remains one URL", `${probeUrl},https://example.org/unique`, `${probeUrl},https://example.org/unique`, "covered"],
  // fail closed: literal containment only (#505 redesign)
  ["review1", "filename Markdown delimiters", "Use `facts.csv`.", "Use **facts.csv**.", "rejected"],
  ["verify", "Unicode filename preserved", "API používá příručka.xlsx.", "API používá příručka.xlsx.", "covered"],
  ["verify", "Czech currency preserved", "API stojí 50 Kč.", "API stojí 50 Kč.", "covered"],
  ["verify", "Unicode path changed", "API používá návody/příručka.xlsx.", "API používá návody/příručky.xlsx.", "rejected"],
  ["verify", "combining filename suffix", "API používá příručka.xlsx.", "API používá příručka.xlsx\u0301.", "rejected"],
  ["verify", "combining filename preserved", "API používá příručka.xlsx.".normalize("NFD"), "API používá příručka.xlsx.".normalize("NFD"), "covered"],
  ["verify", "currency decimal changed", "API stojí 50 Kč.", "API stojí 50,80 Kč.", "rejected"],
  ["verify", "currency decimal preserved", "API stojí 50,80 Kč.", "API stojí 50,80 Kč.", "covered"],
  ["verify", "NBSP before unit", "API stojí 50 Kč.", "API stojí 50\u00a0Kč.", "covered"],
  ["verify", "decimal suffix", "Limit je 456.", "Limit je 123,456.", "rejected"],
  ["verify", "grouped prefix", "Limit je 123,456.", "Limit je 123,456,789.", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "comma prose boundary", "Limit je 123.", "Limit je 123, celkem.", "covered", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "URL Unicode query preserved", `[zdroj](${probeUrl}?q=číslo&n=123,456)`, `<${probeUrl}?q=číslo&n=123,456>`, "rejected"],
  ["verify", "URL query changed", `[zdroj](${probeUrl}?q=číslo&n=123,456)`, `<${probeUrl}?q=číslo&n=123>`, "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "triple emphasis", `***${probeUrl}***`, probeUrl, "rejected", "covered"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "italic", `*${probeUrl}*`, probeUrl, "rejected", "covered"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "strikethrough", `~~${probeUrl}~~`, probeUrl, "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "code preserves dot", `\`${probeUrl}.\``, `[copy](${probeUrl}.)`, "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "adjacent Markdown content", `[zdroj](${probeUrl}.)API používá příručka.xlsx.`, `\`${probeUrl}.\` API používá příručka.xlsx.`, "rejected"],
  ["verify", "space-grouped currency", "API stojí 1 234 Kč.", "API stojí 234 Kč.", "rejected"],
  ["verify", "space-grouped integer", "Limit je 1 234.", "Limit je 234.", "rejected"],
  ["verify", "integer suffix in spaced value", "Limit je 123.", "Limit je 1 123.", "rejected"],
  ["verify", "currency suffix in spaced value", "API stojí 123 Kč.", "API stojí 1 123 Kč.", "rejected"],
  ["verify", "currency suffix in comma value", "API stojí 123 Kč.", "API stojí 1,123 Kč.", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "unit list punctuation", "Limity jsou 50 Kč,123 Kč.", "Limity jsou 50 Kč a 123 Kč.", "rejected"],
  ["verify", "decimal list", "Hodnoty jsou 123,456.", "Hodnoty jsou 123,456.", "covered"],
  ["verify", "Czech grouping preserved", "API stojí 1.234,56 Kč.", "API stojí 1.234,56 Kč.", "covered"],
  ["verify", "English grouping preserved", "Limit je 1,234.56.", "Limit je 1,234.56.", "covered"],
  ["verify", "comma grouping preserved", "Limit je 123,456,789.", "Limit je 123,456,789.", "covered"],
  ["verify", "separator position changed", "API stojí 1.234,56 Kč.", "API stojí 1.234 56 Kč.", "rejected"],
  ["verify", "escaped paren changed", String.raw`[zdroj](https://example.org/export\)old)`, String.raw`[kopie](https://example.org/export\)new)`, "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "escaped paren preserved", String.raw`[zdroj](https://example.org/export\)old)`, String.raw`[kopie](https://example.org/export\)old)`, "rejected"],
  ["verify", "escaped URL cannot truncate", String.raw`[zdroj](https://example.org/export\)literal)`, "`https://example.org/export\\`", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["verify", "bare to Markdown", probeUrl, `[x](${probeUrl})`, "covered", "rejected"],
];

// Additional span invariants, generated as a table rather than separate
// fallback regexes: group spacing, separator positions, units and escapes.
for (const separator of [" ", "\u00a0", "\u202f"]) {
  for (const unit of ["Kč", "%", "€", "$", "MB"]) {
    const full = `1${separator}234${separator}567,89 ${unit}`;
    coverageProbes.push(
      ["spans", `full ${JSON.stringify(full)}`, full, full, "covered"],
      ["spans", `suffix ${JSON.stringify(full)}`, full, `567,89 ${unit}`, "rejected"],
      // fail closed: literal containment only (#505 redesign)
      ["spans", `unit spacing/case changed ${JSON.stringify(full)}`, full, `1 234 567,89${unit.toLowerCase()}`, "rejected"],
    );
  }
}
for (const [left, right] of [["1,234.56", "1.234,56"], ["1 234", "1234"], ["1,25", "1,250"],
  ["1.234,56", "1234,56"], ["123", "1234"], ["1", "1 234"], ["2", "3"], ["123", "123 MB"],
  ["123,456,789", "123,456,780"], ["123", "123abc"], ["123", "123_abc"], ["123", "API-123"],
  ["123", "123/abc"], ["123", "123\\abc"], ["123", "123.md"],
  ["123 MB", "123 MB/abc"], ["1 234", "1\t234"], ["1 234", "1\n234"], ["1 234", "1  234"]]) {
  coverageProbes.push(["spans", `distinct ${JSON.stringify(left)} / ${JSON.stringify(right)}`, left, right, "rejected"]);
}
for (const marker of ["*", "**", "***", "_", "__", "___", "~~"]) {
  for (const punctuation of ["", "!", ".", ",", ";", ":"]) {
    // fail closed: literal containment only (#505 redesign)
    coverageProbes.push(["spans", `${marker} emphasis with ${punctuation}`, `${marker}${probeUrl}${punctuation}${marker}`, probeUrl, "rejected", marker === "~~" ? "rejected" : "covered"]);
  }
}
for (const suffix of [String.raw`\)old`, String.raw`\(old`, String.raw`\(old\)`, String.raw`\\(old)`, String.raw`\\\)old`, String.raw`\*old`, "?q=😀&n=123,456"]) {
  const url = probeUrl + suffix;
  coverageProbes.push(
    // fail closed: literal containment only (#505 redesign)
    ["spans", `escaped/balanced literal ${suffix}`, `[source](${url})`, `\`${url}\``, "rejected"],
    ["spans", `escaped/balanced changed ${suffix}`, `[source](${url})`, `[copy](${url}new)`, "rejected"],
  );
}
for (const raw of [`${probeUrl}*`, `${probeUrl})`, `[source](${probeUrl}_(old`, `*${probeUrl}**`,
  `****${probeUrl}****`, String.raw`\*https://example.org/export*`, `\`${probeUrl}.`, `<${probeUrl}_(old`,
  String.raw`[source\](https://example.org/export.)`, String.raw`\[source](https://example.org/export.)`,
  `source](${probeUrl}.)`,
  String.raw`https://example.org/export\.`]) {
  coverageProbes.push(
    ["spans", `ambiguous stays raw ${raw}`, raw, probeUrl, "rejected"],
    ["spans", `identical ambiguous ${raw}`, raw, raw, "covered"],
  );
}
coverageProbes.push(
  // fail closed: literal containment only (#505 redesign)
  ["spans", "multiple backtick delimiters", `\`\`${probeUrl}.\`\``, `[copy](${probeUrl}.)`, "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["spans", "literal backtick inside code URL", `\`\`${probeUrl}a\`b\`\``, `[copy](${probeUrl}a\`b)`, "rejected"],
  ["spans", "numeric inline code uses spans", "`123`", "123,456", "rejected"],
  ["spans", "numeric inline phrase uses spans", "`123 456 foo`", "1 123 456 foo", "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["spans", "unit inline code uses spans", "`2gb`", "2 GB", "rejected"],
  ["spans", "URL punctuation explicitly belongs to URL", `[source](${probeUrl}!)`, probeUrl, "rejected"],
  // fail closed: literal containment only (#505 redesign)
  ["spans", "Unicode autolink index", `<${probeUrl}?q=😀>`, `[copy](${probeUrl}?q=😀)`, "rejected"],
);
const tableResults = new Map<string, { directions: number; failures: number }>();
for (const [group, label, source, destination, forward, reverse = forward] of coverageProbes) {
  const result = tableResults.get(group) ?? { directions: 0, failures: 0 };
  tableResults.set(group, result);
  for (const [description, target, expected] of [[source, destination, forward], [destination, source, reverse]] as const) {
    const before = failed;
    const report = findTrimCandidates(`| MEM-604 | ACTIVE | 2026-11-12 | — | ${description} |`, [{
      file: "semantic/details.md", text: `### Verified literal content coverage\nCondensed lesson. [MEM-604]\n${target}`,
    }]);
    const coverage = report.contentCoverage[0];
    assert(coverage.status === expected, `#505 table ${group}: ${label}: ${JSON.stringify(description)} -> ${JSON.stringify(target)} expected ${expected}; got ${JSON.stringify(coverage)}`);
    assert((report.candidates.length === 0) === (expected === "rejected"), `#505 table ${group}: ${label}: candidate eligibility follows coverage`);
    assert(JSON.stringify(coverage.missingTokens) === JSON.stringify(expected === "rejected" ? ["no-literal-match"] : []), `#505 table ${group}: ${label}: one reason explains rejection`);
    assert(coverage.tokens.length === 0, `#505 table ${group}: ${label}: legacy token list stays empty`);
    result.directions++;
    if (failed > before) result.failures++;
  }
}
for (const [group, result] of tableResults) {
  console.log(`#505 table ${group}: ${result.directions} directions, ${result.failures} failed`);
}
for (const continuation of ["/", "+", "-", "−", ",", ".", "~"]) {
  assert(inspectCoverage("API", `API${continuation}číslo`).status === "rejected",
    `#505 boundary: right ${continuation} continuation rejects`);
  assert(inspectCoverage("API", `číslo${continuation}API`).status === "rejected",
    `#505 boundary: left ${continuation} continuation rejects`);
}
for (const letter of ["č", "９", "𐐀", "𝟠"]) {
  assert(inspectCoverage("API", `API${letter}`).status === "rejected", `#505 boundary: right Unicode ${letter}`);
  assert(inspectCoverage("API", `${letter}API`).status === "rejected", `#505 boundary: left Unicode ${letter}`);
}
assert(inspectCoverage("API", "API/h; (API)").status === "covered", "#505: keep searching after an unbounded first occurrence");
assert(inspectCoverage("API stojí 1 234 Kč.", "API\tstojí\n1\u202f234\u2009Kč").status === "covered",
  "#505: destination newlines fold to spaces too");
for (const empty of ["", " ", ".", "- .", "* .", "1. ."]) {
  assert(inspectCoverage(empty, "Unrelated prose").status === "rejected", "#505: empty normalized bodies fail closed");
}
// Complete literal bodies survive unchanged, including punctuation.
for (const value of ["123,456,789", "123.456.789", "1.234,56 Kč", "1 234 Kč", "1\u00a0234 Kč", "1\u202f234 Kč", "1 234 567,89 €", "2", "+123", "-12.5°C"]) {
  assert(inspectCoverage(value, value).status === "covered", `#505 complete number preservation: ${value}`);
}
for (const value of [String.raw`https://example.org/export\)old`, String.raw`https://example.org/export\(old\)`, `${probeUrl}_(part).`]) {
  assert(inspectCoverage(`[source](${value})`, `[source](${value})`).status === "covered", `#505 complete Markdown preservation: ${value}`);
}

const reviewRegistry = [
  "| MEM-608 | ACTIVE | 2026-11-12 | — | API stojí 50 Kč. |",
  "| MEM-607 | ACTIVE | 2026-11-12 | — | API používá příručka.xlsx. |",
  "| MEM-606 | ACTIVE | 2026-11-12 | — | Limit je 123. |",
  "| MEM-605 | ACTIVE | 2026-11-12 | — | [source](https://example.org/export.) |",
].join("\n");
const reviewDestinations = [
  { file: "semantic/z.md", text: "### Preserve currency and files\nAPI stojí 80 Kč. [MEM-608]\nAPI používá příručka.xlsx. [MEM-607]" },
  { file: "semantic/a.md", text: "### Preserve amounts and sources\nLimit je 123,456. [MEM-606]\n`https://example.org/export.` [MEM-605]" },
];
const reviewReport = JSON.stringify(findTrimCandidates(reviewRegistry, reviewDestinations));
assert(reviewReport === JSON.stringify(findTrimCandidates(reviewRegistry, reviewDestinations)) &&
  reviewReport === JSON.stringify(findTrimCandidates(reviewRegistry, [...reviewDestinations].reverse())),
  "#505 review1: repeated scans and reversed destination order produce identical reports");

assert(inspectCoverage("Preserve content \\| https://example.org/unique", "No source here").status === "rejected", "#505: content after an escaped table pipe remains guarded");
const otherFile = findTrimCandidates(coverageRegistry, [...coverageDestinations, {
  file: "semantic/unrelated.md", text: "https://example.org/Questions2017 questions.xlsx",
}]);
assert(!otherFile.candidates.some((c) => c.key === "MEM-601"), "#505: tokens in a different file cannot cover the selected destination");
assert(trimPromotedRows(coverageRegistry, coverageDestinations).registry.includes("| MEM-601 | ACTIVE | 2026-11-12 | — | Read https://"),
  "#505: the convenience apply wrapper also preserves rejected rows");

const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-registry-coverage-"));
try {
  fs.mkdirSync(path.join(coverageRoot, "memory/semantic"), { recursive: true });
  fs.writeFileSync(path.join(coverageRoot, "CLAUDE.md"), "fixture");
  const registryPath = path.join(coverageRoot, "memory/MEM_REGISTRY.md");
  fs.writeFileSync(registryPath, coverageRegistry);
  for (const destination of coverageDestinations) {
    fs.writeFileSync(path.join(coverageRoot, "memory", destination.file), destination.text);
  }
  const runCoverageCli = (...args: string[]) => spawnSync(process.execPath,
    [...process.execArgv, path.resolve("skills/memory/scripts/mem-registry-trim.ts"), ...args],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: coverageRoot } });
  const proposal = runCoverageCli();
  const report = JSON.parse(proposal.stdout.split("\n").find((line) => line.startsWith("contentCoverage: "))!.slice("contentCoverage: ".length));
  assert(proposal.status === 0 && report.find((r: { key: string }) => r.key === "MEM-601").missingTokens.join() === "no-literal-match",
    "#505: CLI emits additive machine-readable rejection reasons");
  assert(proposal.stdout.includes("no-literal-match") && proposal.stdout.includes("do not hand-trim"), "#505: CLI explains rejected rows with no-literal-match");
  assert(!proposal.stdout.includes("MEM-601 →") && proposal.stdout.includes("MEM-602 →"), "#505: CLI proposes only eligible rows");
  assert(fs.readFileSync(registryPath, "utf8") === coverageRegistry, "#505: proposal mode is read-only");
  const rejectedApply = runCoverageCli("--apply", "--only", "MEM-601,MEM-602");
  assert(rejectedApply.status === 1 && rejectedApply.stdout.includes("contentCoverage: "), "#505: apply reports coverage and refuses a rejected key");
  assert(fs.readFileSync(registryPath, "utf8") === coverageRegistry, "#505: rejected key aborts the entire apply without writing");
  const coveredApply = runCoverageCli("--apply", "--only", "MEM-602");
  assert(coveredApply.status === 0, `#505: CLI still applies fully covered rows: ${coveredApply.stderr}`);
  assert(fs.readFileSync(registryPath, "utf8").includes("| MEM-602 | ACTIVE | 2026-11-12 | semantic/covered.md:"), "#505: approved covered row becomes a pointer");
} finally {
  fs.rmSync(coverageRoot, { recursive: true, force: true });
}

console.log(`${passed} assertions passed, ${failed} failed`);
if (failed) process.exitCode = 1;
