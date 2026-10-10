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
| MEM-240 | ACTIVE | 2026-08-20 | — | first mentioned in a leading RUN of 3 separate tags (still ambiguous), has its own dedicated single-key line elsewhere — leading-run-of-tags check (DevGuru, poller-brain#334 review round 1, blocking 1) |
| MEM-241 | ACTIVE | 2026-08-20 | — | co-mentioned only in the leading run-of-tags line with MEM-240 and MEM-242 — never cited alone anywhere |
| MEM-242 | ACTIVE | 2026-08-20 | — | co-mentioned only in the leading run-of-tags line with MEM-240 and MEM-241 — never cited alone anywhere |
| MEM-250 | ACTIVE | 2026-08-20 | — | subject of a leading tag on a line that ALSO contains wikilink cross-refs (index-shaped, excluded), has its own dedicated single-key line elsewhere — wikilink cross-ref check (DevGuru, poller-brain#334 review round 1, to-fix 2) |
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
