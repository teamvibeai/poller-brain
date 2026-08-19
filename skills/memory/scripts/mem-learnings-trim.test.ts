#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the LEARNINGS.md promoted-entry trim logic.
 *
 * Two fixture families, because different brains use different LEARNINGS.md
 * conventions and round 1 of this module only ever tested against one
 * (DevGuru catch, poller-brain#300 review round 2 — 25 green assertions
 * over a file shape that, on the brain DevGuru actually tested against,
 * doesn't exist):
 *   - BULLET_LEARNINGS: one bullet per lesson (`- **Title** — body.
 *     (Source: ..., [MEM-N])`), as used by vibe-keeper-brain's real
 *     core/LEARNINGS.md.
 *   - HEADING_LEARNINGS: `### Heading` + Rule/Why/How-to-apply bold-label
 *     paragraphs spanning multiple lines per entry, as used by
 *     the file's own documented footer convention ("Format: short rule,
 *     **Why:**, **How to apply:**") and confirmed live against a real
 *     brain by DevGuru.
 *
 * Runs the count-verify conditions against string fixtures (no fs):
 *   - findLearningsTrimCandidates is read-only and never mutates LEARNINGS.md
 *   - promotion gate: an entry is proposed only if it cites EXACTLY ONE
 *     MEM-N key ACROSS ITS WHOLE SPAN (not just its first/last line) AND
 *     that key has a genuine single-key citation in a destination file
 *   - multi-key-entry rejection is per-ENTRY, not per-line: an entry whose
 *     two distinct keys each land on their OWN single-key line (the
 *     MEM-115/MEM-95 shape DevGuru found in a real corroborated-finding
 *     entry) must still be rejected as a whole — round 1's line-based scan
 *     would have proposed each line as an independent single-key candidate
 *     and split one entry across two rewrites
 *   - multi-key-line rejection on the destination side too (inherited from
 *     citation-detect.ts): scan-past-rejection finds a key's OWN dedicated
 *     single-key line even when an earlier ambiguous shared line also
 *     mentions it
 *   - index-shaped destination lines (pointer/lookup rows) are excluded
 *     from citation evidence AND reported via indexRejections, never
 *     silently dropped
 *   - each candidate carries the FULL citing line, not just the hook
 *   - applyLearningsTrimCandidates only rewrites entries for keys explicitly
 *     present in the given candidate list, and replaces the ENTIRE entry
 *     span (never leaves an orphaned remainder line behind)
 *   - the rewritten pointer's marker matches the entry's own format (`- `
 *     for a bullet entry, `### ` for a heading entry)
 *   - idempotence: an entry already rewritten to a pointer is never
 *     re-proposed, and a second consecutive apply with no new candidates is
 *     byte-identical
 *   - size never grows
 *   - hazard regression: core/LEARNINGS.md must never be passed as its own
 *     destination — every entry self-cites its own key in the trailing
 *     "(Source: ..., [MEM-N])", so doing so would create spurious
 *     self-pointer candidates. This is enforced by findLearningsTrimCandidates
 *     itself (not just the CLI's DEST_DIRS convention).
 *
 * Run: npx tsx skills/memory/scripts/mem-learnings-trim.test.ts
 * Exits non-zero on the first failed assertion.
 */

import {
  findLearningsTrimCandidates,
  applyLearningsTrimCandidates,
  trimPromotedLearnings,
  verifyLearningsTrimStats,
  type DestinationFile,
  type LearningsTrimCandidate,
} from "./lib/mem-learnings-trim-core.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// ===========================================================================
// Suite 1: bullet-format LEARNINGS.md (vibe-keeper-brain's real convention)
// ===========================================================================

const BULLET_LEARNINGS = `# Learnings

- **NIKDY žádný krok způsobující ztrátu dat** — local phrasing, full detail moved elsewhere. (Source: Jakub, 2026-07-28, [MEM-99])
- **Bounded-field rule** — cap every new field you add. (Source: DevGuru, [MEM-93][MEM-94][MEM-122])
- **Correction lesson** — the suspicious thing was flagged, later cleared. (Source: X, [MEM-172])
- **Never promoted lesson** — stays untouched. (Source: Z, 2026-07-28, [MEM-200])
- [MEM-50] → see episodic/2026-01-01-old.md:3 — already trimmed
`;

const BULLET_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/topic.md",
    text: [
      "### NIKDY žádný krok způsobující ztrátu dat",
      "",
      "- **NIKDY žádný krok způsobující ztrátu dat** — full incident writeup. [MEM-99]",
      "",
      "### Bounded-field rule",
      "",
      "- **bounded-field rule** — sibling family listed for cleanup. [MEM-93][MEM-94][MEM-122]",
      "",
      "### Correction lesson",
      "",
      "- **[MEM-172] correction:** the suspicious thing was a false positive ([MEM-166]).",
      "- **[MEM-172] dedicated recap:** the monitoring pipeline is confirmed working end-to-end.",
    ].join("\n"),
  },
];

const bulletFound = findLearningsTrimCandidates(BULLET_LEARNINGS, BULLET_DESTINATIONS);

assert(bulletFound.totalEntries === 5, "bullet: should find 5 top-level entries");
assert(bulletFound.alreadyPointer === 1, "bullet: the [MEM-50] entry is already a pointer");
assert(bulletFound.multiKeyEntries === 1, "bullet: the bounded-field entry (3 keys on one line) is multi-key");
assert(
  bulletFound.candidates.length === 2,
  "bullet: only MEM-99 (clean single-key) and MEM-172 (has its own dedicated single-key destination line) are proposed"
);
assert(
  bulletFound.candidates.map((c) => c.key).join(",") === "MEM-99,MEM-172",
  "bullet: proposed exactly the correct keys, sorted numerically"
);

const bulletMem99 = bulletFound.candidates.find((c) => c.key === "MEM-99")!;
assert(bulletMem99.format === "bullet", "bullet: MEM-99 candidate recorded as a bullet-format entry");
assert(
  bulletMem99.entryStartLine === 3 && bulletMem99.entryEndLine === 3,
  "bullet: MEM-99 candidate points at the right single-line LEARNINGS.md entry span"
);
assert(bulletMem99.file === "semantic/topic.md" && bulletMem99.line === 3, "bullet: MEM-99 candidate points at the right destination file:line");
assert(
  bulletMem99.lineText.includes("full incident writeup"),
  "bullet: MEM-99 candidate carries the FULL citing line, not just the hook"
);
assert(
  bulletMem99.hook === "NIKDY žádný krok způsobující ztrátu dat",
  "bullet: MEM-99 hook extracted from its governing heading, not the citing line's bold span"
);

const bulletMem172 = bulletFound.candidates.find((c) => c.key === "MEM-172")!;
assert(
  bulletMem172.entryStartLine === 5 && bulletMem172.line === 12 && bulletMem172.lineText.includes("dedicated recap"),
  "bullet: MEM-172 candidate uses its OWN single-key destination line (line 12), not the ambiguous shared line (line 11) — scan-past-rejection"
);
assert(bulletMem172.hook === "Correction lesson", "bullet: MEM-172 hook extracted from its governing heading");

// Approve ONLY MEM-99 — MEM-172, despite being a valid candidate, must stay untouched.
const bulletPartial = applyLearningsTrimCandidates(BULLET_LEARNINGS, [bulletMem99]);
const bulletCPartial = verifyLearningsTrimStats(bulletPartial.stats);
assert(
  bulletPartial.stats.trimmedEntries === 1 && bulletPartial.stats.trimmedKeys.join(",") === "MEM-99",
  "bullet: only the approved candidate is applied"
);
assert(
  bulletPartial.learnings.includes("**Correction lesson** — the suspicious thing was flagged"),
  "bullet: MEM-172 (a valid but NOT approved candidate) is left completely untouched — propose/apply split"
);
assert(bulletCPartial.length === 3, "bullet: all 3 verify checks passed");

const bulletR1 = applyLearningsTrimCandidates(BULLET_LEARNINGS, bulletFound.candidates);
verifyLearningsTrimStats(bulletR1.stats);
assert(bulletR1.stats.trimmedEntries === 2, "bullet: both proposed candidates applied when both are approved");
assert(
  bulletR1.learnings.includes("- [MEM-99] → see semantic/topic.md:3 — NIKDY žádný krok způsobující ztrátu dat (Source: Jakub, 2026-07-28)"),
  "bullet: MEM-99 entry rewritten to a `-` pointer with correct file:line, hook, and preserved provenance"
);
assert(
  bulletR1.learnings.includes("- [MEM-172] → see semantic/topic.md:12 — Correction lesson (Source: X)"),
  "bullet: MEM-172 entry trimmed using its OWN single-key destination line (line 12), provenance preserved"
);
assert(
  bulletR1.learnings.includes("**Bounded-field rule** — cap every new field you add. (Source: DevGuru, [MEM-93][MEM-94][MEM-122])"),
  "bullet: multi-key entry (MEM-93/94/122) is never a candidate — content isn't attributable to a single key"
);
assert(
  bulletR1.learnings.includes("**Never promoted lesson** — stays untouched. (Source: Z, 2026-07-28, [MEM-200])"),
  "bullet: MEM-200 (never cited anywhere) is left completely untouched"
);
assert(
  bulletR1.learnings.includes("- [MEM-50] → see episodic/2026-01-01-old.md:3 — already trimmed"),
  "bullet: pre-existing pointer entry (MEM-50) is left completely untouched"
);
assert(bulletR1.stats.bytesAfter < bulletR1.stats.bytesBefore, "bullet: LEARNINGS.md shrank");

const bulletWrapped = trimPromotedLearnings(BULLET_LEARNINGS, BULLET_DESTINATIONS);
assert(bulletWrapped.learnings === bulletR1.learnings, "bullet: trimPromotedLearnings == find + apply(all)");

const bulletFound2 = findLearningsTrimCandidates(bulletR1.learnings, BULLET_DESTINATIONS);
assert(bulletFound2.candidates.length === 0, "bullet: re-scanning the trimmed LEARNINGS.md proposes nothing new");
assert(bulletFound2.alreadyPointer === 3, "bullet: run 2 finds all 3 trimmed/pre-existing entries as already-pointers");

const bulletR2 = applyLearningsTrimCandidates(bulletR1.learnings, bulletFound2.candidates);
verifyLearningsTrimStats(bulletR2.stats);
assert(bulletR2.learnings === bulletR1.learnings, "bullet: a second apply pass is byte-identical (idempotent)");

// ===========================================================================
// Suite 2: heading-format LEARNINGS.md (### + Rule/Why/How-to-apply
// bold-label paragraphs — DevGuru's real-brain convention, poller-brain#300
// review round 2). Multi-line entries throughout, on purpose.
// ===========================================================================

const HEADING_LEARNINGS = `# Learnings

### Never call CI green from diff review alone
**Rule:** CI status and manual verification are two separate signals, never merge them into one "GREEN".
**Why:** a diff looked merge-ready from DevGuru review alone, but the first live CI run caught an e2e gap hidden behind a needs: dependency.
**How to apply:** always check live check-runs AND read the workflow YAML for needs: dependencies before calling anything GREEN. (Source: Jakub, 2026-07-29, [MEM-163])

### Bounded field rule
**Rule:** cap every new field you add.
**Why:** unbounded fields accumulate silently.
**How to apply:** ask what's before it that could grow unbounded. (Source: DevGuru, [MEM-93][MEM-94][MEM-122])

### Corroborated finding, split across lines
**Rule:** the same pattern held on a second, independent occurrence.
**Why:** Corroborated 2026-08-02 (MEM-115): the first incident's root cause reproduced exactly.
**How to apply:** apply the existing fix unchanged (MEM-95, 2026-07-24.)

### Never promoted heading lesson
**Rule:** stays untouched forever, cited nowhere else.
**Why:** no deeper writeup exists yet.
**How to apply:** n/a. (Source: Z, 2026-07-28, [MEM-200])

### [MEM-50] → see episodic/2026-01-01-old.md:3 — already trimmed
`;

const HEADING_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/topic.md",
    text: [
      "### CI green discipline",
      "",
      "- **CI green discipline** — full incident writeup, PR#254 postmortem. [MEM-163]",
      "",
      "### Bounded field rule",
      "",
      "- **bounded-field rule** — sibling family listed for cleanup. [MEM-93][MEM-94][MEM-122]",
    ].join("\n"),
  },
];

const headingFound = findLearningsTrimCandidates(HEADING_LEARNINGS, HEADING_DESTINATIONS);

assert(headingFound.totalEntries === 5, "heading: should find 5 top-level entries despite multi-line spans");
assert(headingFound.alreadyPointer === 1, "heading: the [MEM-50] entry is already a pointer");
assert(
  headingFound.multiKeyEntries === 2,
  "heading: bounded-field (3 keys, one line) AND the split corroborated-finding entry (MEM-115 + MEM-95, TWO DIFFERENT LINES of the SAME entry) are both multi-key — this is the exact per-entry-not-per-line fix (DevGuru catch, review round 2)"
);
assert(
  headingFound.candidates.length === 1 && headingFound.candidates[0].key === "MEM-163",
  "heading: only MEM-163 (clean single-key, cited in a destination) is proposed — the split-key entry must NOT be proposed for either MEM-115 or MEM-95"
);

const headingMem163 = headingFound.candidates[0];
assert(headingMem163.format === "heading", "heading: MEM-163 candidate recorded as a heading-format entry");
assert(
  headingMem163.entryStartLine === 3 && headingMem163.entryEndLine === 6,
  "heading: MEM-163 candidate span covers the WHOLE 4-line entry (### + Rule + Why + How to apply), not just the line citing the key"
);

// Apply: the whole multi-line span must be replaced with ONE pointer line, no orphaned paragraph remainder.
const headingR1 = applyLearningsTrimCandidates(HEADING_LEARNINGS, headingFound.candidates);
verifyLearningsTrimStats(headingR1.stats);
assert(headingR1.stats.trimmedEntries === 1, "heading: exactly one entry trimmed");
assert(
  headingR1.learnings.includes("### [MEM-163] → see semantic/topic.md:3 — CI green discipline (Source: Jakub, 2026-07-29)"),
  "heading: entry rewritten to a `###` pointer (matching its own entry format), with provenance preserved"
);
assert(
  headingR1.learnings.match(/\*\*Rule:\*\*/g)!.length === 3,
  "heading: the trimmed entry's **Rule:**/**Why:**/**How to apply:** paragraph lines are GONE — only the 3 untouched entries' paragraphs remain (no orphaned remainder under the new pointer)"
);
assert(
  !headingR1.learnings.includes("first live CI run caught an e2e gap"),
  "heading: the trimmed entry's **Why:** line is fully gone, not left dangling under the new pointer"
);
// The multi-line split-key entry must be completely untouched (never a candidate).
assert(
  headingR1.learnings.includes("Corroborated 2026-08-02 (MEM-115): the first incident's root cause reproduced exactly."),
  "heading: split-key entry (MEM-115/MEM-95 on separate lines) is left completely untouched"
);
assert(
  headingR1.learnings.includes("apply the existing fix unchanged (MEM-95, 2026-07-24.)"),
  "heading: split-key entry's second line is also left completely untouched"
);
assert(headingR1.stats.bytesAfter < headingR1.stats.bytesBefore, "heading: LEARNINGS.md shrank");

const headingFound2 = findLearningsTrimCandidates(headingR1.learnings, HEADING_DESTINATIONS);
assert(headingFound2.candidates.length === 0, "heading: re-scanning the trimmed LEARNINGS.md proposes nothing new");
assert(headingFound2.alreadyPointer === 2, "heading: run 2 finds both trimmed/pre-existing entries as already-pointers");
assert(headingFound2.totalEntries === 5, "heading: entry count is stable across a trim (span collapses to 1 line, still 1 entry)");

const headingR2 = applyLearningsTrimCandidates(headingR1.learnings, headingFound2.candidates);
verifyLearningsTrimStats(headingR2.stats);
assert(headingR2.learnings === headingR1.learnings, "heading: a second apply pass is byte-identical (idempotent)");

// ===========================================================================
// Cross-cutting invariants and hazard regressions
// ===========================================================================

// --- verifyLearningsTrimStats FAIL LOUD on a broken invariant -----------
let threw = false;
try {
  verifyLearningsTrimStats({
    totalEntries: 1,
    multiKeyEntries: 0,
    alreadyPointer: 0,
    candidateEntries: 1,
    trimmedEntries: 1,
    trimmedKeys: ["MEM-1"],
    bytesBefore: 100,
    bytesAfter: 150, // grew — must throw
    distinctKeysBefore: 1,
    distinctKeysAfter: 1,
  });
} catch {
  threw = true;
}
assert(threw, "verifyLearningsTrimStats throws when LEARNINGS.md size grows");

let keysThrew = false;
try {
  verifyLearningsTrimStats({
    totalEntries: 1,
    multiKeyEntries: 0,
    alreadyPointer: 0,
    candidateEntries: 1,
    trimmedEntries: 1,
    trimmedKeys: ["MEM-1"],
    bytesBefore: 100,
    bytesAfter: 80,
    distinctKeysBefore: 5,
    distinctKeysAfter: 4, // a key disappeared — must throw (replaces the old tautological alreadyPointer+candidateEntries==totalEntries check, DevGuru catch)
  });
} catch {
  keysThrew = true;
}
assert(keysThrew, "verifyLearningsTrimStats throws when a distinct MEM-N key is lost across the trim");

// --- core/ destination guard is enforced in the lib fn itself, not just the
// CLI's DEST_DIRS constant (DevGuru catch, poller-brain#300 review round 1:
// a caller bypassing the CLI could previously reopen the self-citation
// hazard — see module doc point 1).
let coreThrew = false;
try {
  findLearningsTrimCandidates(BULLET_LEARNINGS, [{ file: "core/LEARNINGS.md", text: BULLET_LEARNINGS }]);
} catch {
  coreThrew = true;
}
assert(coreThrew, "findLearningsTrimCandidates throws when a destination is under core/, rather than silently self-citing every entry");

// --- index/pointer-shaped destination lines are rejected as evidence, AND
// reported (DevGuru catch, poller-brain#300 review round 1 + round 2:
// mem-registry-trim.ts proposed 10 candidates today off an MEM-key → file
// index/lookup table, all 10 rejected on review — an index row isn't
// condensed narrative, it's a pointer to elsewhere; round 2 requires the
// rejection itself to be visible, not just silently excluded).
const INDEX_LEARNINGS = `# Learnings

- **Index-adjacent lesson** — should NOT be trimmed off an index row. (Source: Y, 2026-07-28, [MEM-201])
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
const indexFound = findLearningsTrimCandidates(INDEX_LEARNINGS, INDEX_DESTINATIONS);
assert(
  indexFound.candidates.length === 0,
  "an index/lookup-table row citing exactly one key is NOT treated as narrative evidence — it's a pointer, not condensed content"
);
assert(
  indexFound.indexRejections.length === 1 &&
    indexFound.indexRejections[0].key === "MEM-201" &&
    indexFound.indexRejections[0].file === "semantic/kb-index.md",
  "the index row rejection is reported (not silently dropped) — caller can see coverage wasn't lost, it was correctly excluded"
);

// --- applyLearningsTrimCandidates guards against a stale candidate list --
// DevGuru catch (poller-brain#300 review round 1): candidates are keyed by
// ENTRY START LINE, not re-parsed from the span being written. A candidate
// computed against different content — say, an intervening edit shifted
// line numbers — must never silently overwrite the wrong entry.
const STALE_LEARNINGS = `# Learnings

- **Unrelated entry, not MEM-99** — nothing to do with the stale candidate. (Source: Q, 2026-07-28, [MEM-777])
`;
const staleCandidate: LearningsTrimCandidate = {
  key: "MEM-99",
  format: "bullet",
  entryStartLine: 3, // points at the MEM-777 entry above, not a MEM-99 entry
  entryEndLine: 3,
  file: "semantic/topic.md",
  line: 1,
  lineText: "stale citation",
  hook: "stale hook",
};
let staleThrew = false;
try {
  applyLearningsTrimCandidates(STALE_LEARNINGS, [staleCandidate]);
} catch {
  staleThrew = true;
}
assert(staleThrew, "applyLearningsTrimCandidates throws instead of overwriting an entry that doesn't actually cite the candidate's key");

// --- poller-brain#343 regression: a destination heading that self-tags a
// DIFFERENT key than the one being cited (e.g. `## Title [MEM-213][MEM-214]`
// governing a dedicated single-key line for MEM-213 only) must NOT drag the
// foreign key (MEM-214) into the new LEARNINGS.md pointer's hook — that
// silently changes the document's distinct-key set and (pre-fix) tripped
// verifyLearningsTrimStats's count-verify guard, independent of which
// candidate was selected.
const MULTIKEY_HEADING_LEARNINGS = `# Learnings

### Reaction scoping lesson
**Rule:** a Slack reaction only shows for the user who added it, not shared team-wide.
**Why:** assumed reactions were a shared signal; they aren't.
**How to apply:** never rely on a reaction count as a cross-user signal. (Source: X, [MEM-213])
`;

const MULTIKEY_HEADING_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/session-tooling-limitations.md",
    text: [
      "## Slack reactions are per-adding-user, not shared [MEM-213][MEM-214]",
      "",
      "- reactions are scoped to the adding user's own view. [MEM-213]",
    ].join("\n"),
  },
];

const multikeyFound = findLearningsTrimCandidates(MULTIKEY_HEADING_LEARNINGS, MULTIKEY_HEADING_DESTINATIONS);
assert(
  multikeyFound.candidates.length === 1 && multikeyFound.candidates[0].key === "MEM-213",
  "multi-key heading: MEM-213 is still proposed despite its governing heading also tagging MEM-214"
);
assert(
  !multikeyFound.candidates[0].hook.includes("MEM-214") && !multikeyFound.candidates[0].hook.includes("MEM-213"),
  "multi-key heading: extracted hook has BOTH the foreign key (MEM-214) and the redundant self-citation (MEM-213) stripped"
);
assert(
  multikeyFound.candidates[0].hook === "Slack reactions are per-adding-user, not shared",
  "multi-key heading: stripped hook keeps the descriptive prose intact"
);

const multikeyR1 = applyLearningsTrimCandidates(MULTIKEY_HEADING_LEARNINGS, multikeyFound.candidates);
verifyLearningsTrimStats(multikeyR1.stats); // must NOT throw — this is the exact pb#343 abort reproduction
assert(
  multikeyR1.stats.distinctKeysBefore === multikeyR1.stats.distinctKeysAfter,
  "multi-key heading: MEM-214 (never cited anywhere in LEARNINGS.md) is NOT introduced by the trim — distinct-key set is unchanged"
);
assert(
  !multikeyR1.learnings.includes("MEM-214"),
  "multi-key heading: the rewritten pointer line does not mention the foreign key at all"
);

// --- poller-brain#343 round 2 (DevGuru catch): a governing heading wraps
// its own citation tag in BACKTICKS, not just brackets — the original
// bracket-only strip left a dangling empty code span (`` `` ``) instead of
// cleanly removing the whole wrapped unit.
const BACKTICK_TAG_LEARNINGS = `# Learnings

### Backtick-wrapped tag lesson
**Rule:** a governing heading may wrap its own citation tag in backticks, not just brackets.
**Why:** real brains do this; a bracket-only strip leaves a dangling empty code span behind.
**How to apply:** treat backtick-wrapped tags the same as bracket-only ones. (Source: X, [MEM-257])
`;

const BACKTICK_TAG_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/tooling.md",
    text: [
      "## Session tooling gotcha `[MEM-257]`",
      "",
      "- dedicated single-key line for MEM-257. [MEM-257]",
    ].join("\n"),
  },
];

const backtickFound = findLearningsTrimCandidates(BACKTICK_TAG_LEARNINGS, BACKTICK_TAG_DESTINATIONS);
assert(
  backtickFound.candidates.length === 1 && backtickFound.candidates[0].key === "MEM-257",
  "backtick-wrapped tag: MEM-257 is proposed"
);
assert(
  backtickFound.candidates[0].hook === "Session tooling gotcha",
  "backtick-wrapped tag: the whole backtick+bracket wrapper is stripped as one unit, no dangling empty code span"
);

// --- poller-brain#343 round 2 (DevGuru catch): a MEM-N reference embedded
// MID-heading (not in a safe leading/trailing tag position) can't be
// cosmetically repaired without producing a worse fragment — must be
// excluded via unreliableHooks, not silently stripped-and-shipped, and the
// reported hook must show the REAL reason (the heading text itself, with
// the foreign key visible), not the generic "(no governing heading)" label
// used for the genuinely-no-heading case (that label would be false here —
// a heading DOES exist, it's just unusable as a hook).
const EMBEDDED_KEY_LEARNINGS = `# Learnings

### Halt logic follow-up
**Rule:** a halt condition needs an explicit re-arm step.
**Why:** without it, the halt silently never clears.
**How to apply:** always pair a halt with its re-arm. (Source: Y, [MEM-500])
`;

const EMBEDDED_KEY_DESTINATIONS: DestinationFile[] = [
  {
    file: "procedural/halt-logic.md",
    text: [
      "### Halt logic (mirrors MEM-47)",
      "",
      "- the re-arm step is a dedicated single-key line. [MEM-500]",
    ].join("\n"),
  },
];

const embeddedFound = findLearningsTrimCandidates(EMBEDDED_KEY_LEARNINGS, EMBEDDED_KEY_DESTINATIONS);
assert(
  embeddedFound.candidates.length === 0,
  "embedded mid-heading key: MEM-500's governing heading cites a DIFFERENT key (MEM-47) mid-sentence, not a safe tag position — MEM-500 is NOT proposed"
);
assert(
  embeddedFound.unreliableHooks.length === 1 && embeddedFound.unreliableHooks[0].key === "MEM-500",
  "embedded mid-heading key: MEM-500 is routed to unreliableHooks instead of silently dropped"
);
assert(
  embeddedFound.unreliableHooks[0].hook.includes("MEM-47"),
  'embedded mid-heading key: the reported hook shows the real heading text (foreign MEM-47 visible), not a false "(no governing heading)" label'
);

// --- poller-brain#343 round 2 (DevGuru catch): a heading-wide punctuation
// cleanup pass must never touch text that has nothing to do with the
// stripped tag — regression-locks that only the tag boundary is touched.
const UNRELATED_PUNCTUATION_LEARNINGS = `# Learnings

### Config default lesson
**Rule:** a feature flag default must be explicit, not inferred.
**Why:** an inferred default silently drifted between environments.
**How to apply:** always set both branches explicitly. (Source: Z, [MEM-600])
`;

const UNRELATED_PUNCTUATION_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/flags.md",
    text: [
      "## Feature flag semantics isProduction ? undefined : fallback [MEM-600]",
      "",
      "- dedicated single-key line. [MEM-600]",
    ].join("\n"),
  },
];

const punctFound = findLearningsTrimCandidates(UNRELATED_PUNCTUATION_LEARNINGS, UNRELATED_PUNCTUATION_DESTINATIONS);
assert(
  punctFound.candidates.length === 1 && punctFound.candidates[0].key === "MEM-600",
  "unrelated punctuation: MEM-600 is proposed"
);
assert(
  punctFound.candidates[0].hook === "Feature flag semantics isProduction ? undefined : fallback",
  "unrelated punctuation: the space before the unrelated ':' mid-heading survives untouched — proves cleanup is scoped to the tag boundary, not heading-wide"
);

// --- poller-brain#343 round 3 (DevGuru catch, measured on his own brain's
// 96 real headings): a BARE, unwrapped MEM-N token must never be treated as
// safe tag position — independently-optional wrapper chars let the old
// leading/trailing match grab an UNBALANCED fragment (a lone `]` with no
// matching `[`, or a naked digits-only token), truncating real prose instead
// of removing a real tag. Each case below governs a DIFFERENT key
// (MEM-901/902/903) than the one it's supposedly citing, so a truncated
// hook would be trivially detectable by a human reviewer as wrong — but the
// whole point of `unreliableHooks` is that it never reaches one.
const BARE_TOKEN_LEARNINGS = `# Learnings

### Bracket mismatch follow-up
**Rule:** a citation cluster inside prose can still look like a clean trailing bracket.
**Why:** the lone closing bracket has no matching opener nearby.
**How to apply:** never trust a trailing "]" alone as tag position. (Source: A, [MEM-901])

### Colon-prefixed follow-up
**Rule:** a bare leading key immediately followed by a colon looks like a title prefix.
**Why:** it's actually just prose that happens to start with a citation.
**How to apply:** never strip a bare leading token, colon or not. (Source: B, [MEM-902])

### Trailing bare follow-up
**Rule:** a bare key at the very end of a sentence looks like trailing tag position.
**Why:** it's the object of the sentence, not decoration.
**How to apply:** never strip a bare trailing token either. (Source: C, [MEM-903])

### Accidental-uppercase follow-up
**Rule:** the old lowercase-start check caught bare leading tokens only by luck.
**Why:** a bare key followed by an uppercase word slips right through that check.
**How to apply:** the wrapped-only tag grammar removes the luck dependency. (Source: D, [MEM-904])
`;

const BARE_TOKEN_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/bare-token-shapes.md",
    text: [
      "## Pointer hygiene [see MEM-901]",
      "",
      "- dedicated single-key line for MEM-901. [MEM-901]",
      "",
      "## MEM-902: descriptive title long enough",
      "",
      "- dedicated single-key line for MEM-902. [MEM-902]",
      "",
      "## Everything you need about MEM-903",
      "",
      "- dedicated single-key line for MEM-903. [MEM-903]",
      "",
      "## MEM-904 Adjudication needs a review today",
      "",
      "- dedicated single-key line for MEM-904. [MEM-904]",
    ].join("\n"),
  },
];

const bareFound = findLearningsTrimCandidates(BARE_TOKEN_LEARNINGS, BARE_TOKEN_DESTINATIONS);
assert(
  bareFound.candidates.length === 0,
  "bare token: none of MEM-901/902/903/904 are proposed — every governing heading has a bare, unwrapped token, never a safe tag position"
);
assert(
  bareFound.unreliableHooks.length === 4 &&
    bareFound.unreliableHooks.map((h) => h.key).sort().join(",") === "MEM-901,MEM-902,MEM-903,MEM-904",
  "bare token: all 4 are routed to unreliableHooks instead of a truncated hook"
);
const bareHooks = new Map(bareFound.unreliableHooks.map((h) => [h.key, h.hook]));
assert(
  bareHooks.get("MEM-901") === "Pointer hygiene [see MEM-901]",
  'bare token: MEM-901 heading is untouched, NOT truncated to "Pointer hygiene [see" (unbalanced trailing "]" with no matching "[")'
);
assert(
  bareHooks.get("MEM-902") === "MEM-902: descriptive title long enough",
  'bare token: MEM-902 heading is untouched, NOT truncated to ": descriptive title long enough"'
);
assert(
  bareHooks.get("MEM-903") === "Everything you need about MEM-903",
  'bare token: MEM-903 heading is untouched, NOT truncated to "Everything you need about"'
);
assert(
  bareHooks.get("MEM-904") === "MEM-904 Adjudication needs a review today",
  "bare token: MEM-904 heading is untouched even though the truncated remainder would start uppercase and slip past the old lowercase-start check"
);

// --- distinctKeysBefore/After: the real invariant verify now checks ------
assert(
  bulletR1.stats.distinctKeysBefore === bulletR1.stats.distinctKeysAfter,
  "trimming to pointers never changes the set of distinct MEM-N keys present in LEARNINGS.md"
);
assert(
  headingR1.stats.distinctKeysBefore === headingR1.stats.distinctKeysAfter,
  "same invariant holds for heading-format entries"
);

console.log(`✅ all ${passed} assertions passed`);
