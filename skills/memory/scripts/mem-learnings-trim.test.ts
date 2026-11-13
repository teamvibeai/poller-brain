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
 *   - multi-key-line handling on the destination side too (inherited from
 *     citation-detect.ts, poller-brain#334): a 2-key destination line counts
 *     as evidence for whichever key is in leading subject position (e.g.
 *     `[MEM-172] ... ([MEM-166])`), not for the other, incidentally-
 *     mentioned key — see mem-registry-trim.test.ts for the sibling
 *     scan-past-rejection case (a key with no leading-subject citation on
 *     its first mention still gets found via its OWN dedicated line
 *     elsewhere), same shared citation-detect.ts
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
 * Exits non-zero if any assertion fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  findLearningsTrimCandidates,
  applyLearningsTrimCandidates,
  trimPromotedLearnings,
  verifyLearningsTrimStats,
  verifyLearningsTrimStructure,
  verifyLearningsTrimByteRanges,
  parseOnlySelectors,
  unambiguousHeadlineKeys,
  type DestinationFile,
  type LearningsTrimCandidate,
} from "./lib/mem-learnings-trim-core.js";

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
  bulletMem172.entryStartLine === 5 && bulletMem172.line === 11 && bulletMem172.lineText.includes("correction"),
  "bullet: MEM-172 candidate uses the FIRST line it's the subject of (line 11), even though that line also mentions MEM-166 — subject-position acceptance (poller-brain#334; scan-past-rejection for the no-subject-tag case is covered in mem-registry-trim.test.ts, same shared citation-detect.ts)"
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
  bulletR1.learnings.includes("- [MEM-172] → see semantic/topic.md:11 — Correction lesson (Source: X)"),
  "bullet: MEM-172 entry trimmed using its subject-position destination line (line 11), provenance preserved"
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

// --- parseOnlySelectors: pure --only value parser (DevGuru catch, --------
// poller-brain#334 review round 1, nonblocking 1). Extracted from the CLI
// so it's unit-testable without mocking process.argv/exit.
assert(
  JSON.stringify(parseOnlySelectors("MEM-1,MEM-5")) === JSON.stringify([{ key: "MEM-1", line: null }, { key: "MEM-5", line: null }]),
  "parseOnlySelectors: bare comma-separated keys parse with line=null"
);
assert(
  JSON.stringify(parseOnlySelectors("MEM-25@67")) === JSON.stringify([{ key: "MEM-25", line: 67 }]),
  "parseOnlySelectors: a span selector parses key + line"
);
let overflowThrew = false;
try {
  parseOnlySelectors("MEM-25@3@9");
} catch {
  overflowThrew = true;
}
assert(
  overflowThrew,
  'parseOnlySelectors: "MEM-25@3@9" (more than one "@") throws instead of silently using line=3 and dropping the "9"'
);
let hexThrew = false;
try {
  parseOnlySelectors("MEM-25@0x3");
} catch {
  hexThrew = true;
}
assert(hexThrew, 'parseOnlySelectors: "MEM-25@0x3" throws instead of Number() silently accepting hex as 3');
let zeroThrew = false;
try {
  parseOnlySelectors("MEM-25@0");
} catch {
  zeroThrew = true;
}
assert(zeroThrew, 'parseOnlySelectors: "MEM-25@0" (non-positive line) throws');

// --- unambiguousHeadlineKeys: the printed headline command must never ----
// pre-expand to more than one candidate per key (DevGuru catch,
// poller-brain#334 review round 1, BLOCKING 2 — live-verified: copy-pasting
// the old headline applied both a genuine candidate and a bogus cross-ref
// one sharing the same key, overwriting the cross-ref bullet with a
// duplicate pointer, and all three verify checks stayed green because
// duplicate pointers for one key don't change the distinct-key count).
const headlineCandidates: LearningsTrimCandidate[] = [
  { key: "MEM-25", format: "bullet", entryStartLine: 3, entryEndLine: 3, file: "semantic/topic.md", line: 3, lineText: "x", hook: "Late-fire pattern" },
  { key: "MEM-25", format: "bullet", entryStartLine: 5, entryEndLine: 5, file: "semantic/topic.md", line: 3, lineText: "x", hook: "Late-fire pattern" },
  { key: "MEM-99", format: "bullet", entryStartLine: 7, entryEndLine: 7, file: "semantic/other.md", line: 1, lineText: "y", hook: "Third lesson heading" },
];
assert(
  unambiguousHeadlineKeys(headlineCandidates).join(",") === "MEM-99",
  "unambiguousHeadlineKeys: MEM-25 (2 candidates) is excluded from the headline; only MEM-99 (1 candidate) is included"
);
assert(
  unambiguousHeadlineKeys([headlineCandidates[2]]).join(",") === "MEM-99",
  "unambiguousHeadlineKeys: a key with exactly one candidate is included"
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

// Dated bullet/heading pointers, provenance and full-key counts coexist with legacy entries.
const DATED_A = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DATED_B = "MEM-2026-11-07-203001-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";

const mixedLearnings = [
  `- [${DATED_A}] → see semantic/one.md:1 — Already promoted rule`,
  "- [MEM-12] → see semantic/legacy.md:1 — Legacy promoted rule",
  `### [${DATED_B}:obsolete] → see semantic/two.md:1 — Another promoted rule`,
].join("\n");
const mixedPointers = findLearningsTrimCandidates(mixedLearnings, []);
assert(mixedPointers.alreadyPointer === 3, "LEARNINGS recognises legacy and dated pointers in both formats");
const datedLearning = `- **Important dated lesson** — ${"Original detail worth preserving. ".repeat(12)} (Source: incident, [${DATED_A}])\n`;
const datedDest = [{ file: "semantic/lesson.md", text: `### Stable dated lesson heading\nCondensed lesson [${DATED_A}]` }];
const datedFound = findLearningsTrimCandidates(datedLearning, datedDest);
assert(datedFound.candidates[0]?.key === DATED_A, "LEARNINGS extracts the whole dated identity");
const datedApplied = applyLearningsTrimCandidates(datedLearning, datedFound.candidates);
assert(datedApplied.learnings.startsWith(`- [${DATED_A}] → see `), "LEARNINGS writes full dated pointer");
assert(datedApplied.learnings.includes("(Source: incident)"), "LEARNINGS removes redundant full dated provenance tag");
assert(datedApplied.stats.distinctKeysBefore === 1 && datedApplied.stats.distinctKeysAfter === 1, "LEARNINGS full identity count survives trim");
const multiDatedLearning = findLearningsTrimCandidates(`- Mixed lesson [${DATED_A}] [${DATED_B}]`, datedDest);
assert(multiDatedLearning.multiKeyEntries === 1 && multiDatedLearning.candidates.length === 0, "two same-year dated keys stay multi-key and cannot be trimmed");
assert(parseOnlySelectors(`${DATED_A},${DATED_B}@3`)[1].key === DATED_B, "dated --only span selectors retain exact identity");
const learningRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-id-learnings-"));
try {
  fs.mkdirSync(path.join(learningRoot, "memory/core"), { recursive: true });
  fs.mkdirSync(path.join(learningRoot, "memory/semantic"));
  fs.writeFileSync(path.join(learningRoot, "CLAUDE.md"), "fixture");
  fs.writeFileSync(path.join(learningRoot, "memory/core/LEARNINGS.md"), datedLearning);
  fs.writeFileSync(path.join(learningRoot, "memory/semantic/lesson.md"), datedDest[0].text);
  const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-learnings-trim.ts"), "--apply", "--only", `${DATED_A}@1`],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: learningRoot } });
  assert(cli.status === 0, `LEARNINGS --only dated span finds candidate: ${cli.stderr}`);
  assert(fs.readFileSync(path.join(learningRoot, "memory/core/LEARNINGS.md"), "utf8").startsWith(`- [${DATED_A}] → see `), "LEARNINGS CLI preserves full ID");
} finally {
  fs.rmSync(learningRoot, { recursive: true, force: true });
}

// Lifecycle-tagged destination headings remain ineligible, as on 0ce65634.
// Exercise the real apply CLI: rejection must preserve the source bytes.
for (const key of ["MEM-1", DATED_A]) {
  const original = `- [${key}:obsolete] ${"Original superseded memo, kept for one consolidation cycle. ".repeat(40)}\n`;
  const destination = `### Preserve the complete original lesson [${key}:obsolete]\n\nSuperseded promoted narrative [${key}:obsolete]\n`;
  const found = findLearningsTrimCandidates(original, [{ file: "semantic/topic.md", text: destination }]);
  assert(found.candidates.length === 0, `LEARNINGS lifecycle-tagged heading is ineligible: ${key}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-obsolete-learnings-"));
  try {
    fs.mkdirSync(path.join(root, "memory/core"), { recursive: true });
    fs.mkdirSync(path.join(root, "memory/semantic"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
    const source = path.join(root, "memory/core/LEARNINGS.md");
    fs.writeFileSync(source, original);
    fs.writeFileSync(path.join(root, "memory/semantic/topic.md"), destination);
    const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-learnings-trim.ts"), "--apply", "--only", key],
      { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
    assert(cli.status === 1, `LEARNINGS CLI rejects lifecycle-tagged destination: ${key}`);
    assert(fs.readFileSync(source, "utf8") === original, `LEARNINGS CLI preserves obsolete source byte-for-byte: ${key}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// poller-brain#453: heading blocks own inner bullets, including foreign citations.
const H2_BLOCK = `## [MEM-143] Preserve the incident narrative

Original incident narrative belongs to MEM-143.
- Related evidence [MEM-25] belongs to this narrative.
- Another related lesson [MEM-26] must stay here. ${"Incident evidence must remain part of the original narrative. ".repeat(12)}

### Supporting detail

- More evidence [MEM-25] stays inside the parent block.
`;
const MIXED_H2_LEARNINGS = `# Learnings

- Independent promoted lesson [MEM-99].

${H2_BLOCK}
## [MEM-200] Unpromoted sibling

Sibling narrative survives unchanged.
`;
const H2_DESTINATIONS: DestinationFile[] = [{
  file: "semantic/topic.md",
  text: "### Complete promoted incident lesson\nEvidence [MEM-25]\nEvidence [MEM-26]\nEvidence [MEM-99]\nEvidence [MEM-143]",
}];
const h2Found = findLearningsTrimCandidates(MIXED_H2_LEARNINGS, H2_DESTINATIONS);
assert(h2Found.totalEntries === 3, "h2: parent block, sibling and top-level bullet are the only entries");
assert(h2Found.multiKeyEntries === 1, "h2: foreign citations make the WHOLE parent block multi-key");
assert(h2Found.candidates.map((c) => c.key).join(",") === "MEM-99", "h2: inner MEM-25/MEM-26 bullets are never proposed");
const h2Applied = applyLearningsTrimCandidates(MIXED_H2_LEARNINGS, h2Found.candidates.filter((c) => c.key === "MEM-99"));
assert(h2Applied.learnings.includes(H2_BLOCK), "h2: applying an independent top-level bullet preserves the entire heading block byte-for-byte");
assert(findLearningsTrimCandidates(H2_BLOCK, H2_DESTINATIONS).candidates.length === 0, "h2: heading owns foreign-key bullets through EOF");
const adjacentMultiKey = findLearningsTrimCandidates("## Incident\n- Evidence [MEM-143].\n- Related evidence [MEM-25].\n", H2_DESTINATIONS);
assert(adjacentMultiKey.multiKeyEntries === 1 && adjacentMultiKey.candidates.length === 0,
  "h2: without a blank line, foreign-key bullets still protect the whole multi-key heading block");
const afterTitle = findLearningsTrimCandidates(`${H2_BLOCK}\n# Other lessons\n\n- Independent lesson [MEM-99].\n`, H2_DESTINATIONS);
assert(afterTitle.totalEntries === 2 && afterTitle.candidates[0]?.key === "MEM-99", "h2: a higher-level title closes the block and permits independent top-level bullets");
// #609: one heading-block entry, one MEM-19 bullet; vary only surrounding structure.
const feedbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-feedback-609-"));
try {
  fs.mkdirSync(path.join(feedbackRoot, "memory/core"), { recursive: true });
  fs.mkdirSync(path.join(feedbackRoot, "memory/semantic"));
  fs.writeFileSync(path.join(feedbackRoot, "CLAUDE.md"), "fixture");
  const source = path.join(feedbackRoot, "memory/core/LEARNINGS.md");
  const destinations = [{ file: "semantic/lesson.md", text: "### Complete promoted lesson\nFull incident evidence [MEM-19]" }];
  fs.writeFileSync(path.join(feedbackRoot, "memory/semantic/lesson.md"), destinations[0].text);
  for (const preceding of ["", "## Earlier entry\n\n- [MEM-18] Untouched earlier detail.\n\n"]) {
    for (const blank of ["", "\n"]) {
      for (const suffix of ["", "\n", "\n\n## Following entry\n\n- [MEM-20] Untouched sibling detail.\n"]) {
        const label = `#609 ${preceding ? "preceding h2" : "first entry"}, ${blank ? "blank" : "no blank"}, ${suffix.includes("Following") ? "next heading" : suffix ? "EOF newline" : "EOF"}`;
        const original = `${preceding}## Incident lesson\n${blank}- [MEM-19] ${"Original incident evidence. ".repeat(20).trim()}${suffix}`;
        const found = findLearningsTrimCandidates(original, destinations);
        assert(found.candidates.length === 1 && found.candidates[0]?.format === "heading", `${label}: whole heading entry is eligible`);
        fs.writeFileSync(source, original);
        const cli = spawnSync(process.execPath,
          [...process.execArgv, path.resolve("skills/memory/scripts/mem-learnings-trim.ts"), "--apply", "--only", "MEM-19"],
          { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: feedbackRoot } });
        assert(cli.status === 0, `${label}: CLI applies the single-key entry: ${cli.stderr.trim()}`);
        if (cli.status !== 0) continue;
        const after = fs.readFileSync(source, "utf8");
        assert(after.startsWith(preceding) && after.endsWith(suffix), `${label}: surrounding bytes survive`);
        assert(after === `${preceding}## [MEM-19] → see semantic/lesson.md:2 — Complete promoted lesson${suffix}`,
          `${label}: whole entry becomes one pointer at its original heading level`);
        verifyLearningsTrimStructure(original, after, found.candidates);
        verifyLearningsTrimStats(applyLearningsTrimCandidates(original, found.candidates).stats);
        assert(findLearningsTrimCandidates(after, destinations).alreadyPointer === 1,
          `${label}: pointer is idempotent`);
        if (preceding || suffix.includes("Following")) {
          let refused = false;
          try {
            verifyLearningsTrimStructure(original, after.replace(/Untouched (earlier|sibling) detail/, "Damaged protected text"), found.candidates);
          } catch { refused = true; }
          assert(refused, `${label}: real non-targeted corruption is still rejected`);
        }
      }
    }
  }
} finally {
  fs.rmSync(feedbackRoot, { recursive: true, force: true });
}

const h2Root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-h2-learnings-"));
try {
  fs.mkdirSync(path.join(h2Root, "memory/core"), { recursive: true });
  fs.mkdirSync(path.join(h2Root, "memory/semantic"));
  fs.writeFileSync(path.join(h2Root, "CLAUDE.md"), "fixture");
  const source = path.join(h2Root, "memory/core/LEARNINGS.md");
  fs.writeFileSync(source, MIXED_H2_LEARNINGS);
  fs.writeFileSync(path.join(h2Root, "memory/semantic/topic.md"), H2_DESTINATIONS[0].text);
  // MEM-26 has one false candidate on the old parser, so a bare selector used to write it.
  const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-learnings-trim.ts"), "--apply", "--only", "MEM-26"],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: h2Root } });
  assert(cli.status === 1, `h2: --apply --only inner key refuses: ${cli.stderr}`);
  assert(fs.readFileSync(source, "utf8") === MIXED_H2_LEARNINGS, "h2: refused inner-key apply writes nothing");
  const siblingHierarchy = "## [MEM-200] Preserved parent\n\nDetail.\n\n## [MEM-143] Promoted sibling\n\n" + "Long original narrative. ".repeat(30) + "\n";
  fs.writeFileSync(source, siblingHierarchy);
  const siblingCli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-learnings-trim.ts"), "--apply", "--only", "MEM-143"],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: h2Root } });
  assert(siblingCli.status === 0, `structure: CLI preserves sibling hierarchy when writing a pointer: ${siblingCli.stderr}`);
  assert(fs.readFileSync(source, "utf8").startsWith("## [MEM-200] Preserved parent\n\nDetail.\n\n## [MEM-143] → see "),
    "structure: CLI keeps the earlier entry byte-identical and the target at the same heading level");
  const ambiguous = "# Learnings\n- Evidence [MEM-143].\n";
  fs.writeFileSync(source, ambiguous);
  const skippedCli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-learnings-trim.ts")],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: h2Root } });
  assert(skippedCli.status === 0 && /skipped LEARNINGS.md:2-2:.*ambiguous/.test(skippedCli.stdout), "ambiguity: CLI reports skipped span and reason");
  assert(fs.readFileSync(source, "utf8") === ambiguous, "ambiguity: propose leaves original bytes untouched");
} finally {
  fs.rmSync(h2Root, { recursive: true, force: true });
}

// Every supported heading level owns nested headings and bullets until a same/higher heading.
for (let level = 2; level <= 6; level++) {
  const marker = "#".repeat(level);
  const nested = level < 6 ? `${marker}# Supporting section\n\n` : "";
  const block = `${marker} [MEM-143] Complete incident\n\nOriginal narrative.\n${nested}- Evidence [MEM-143].\n\n`;
  const sibling = `${"#".repeat(Math.min(level, 3))} [MEM-200] Preserved sibling\n\nUnchanged detail.\n`;
  const found = findLearningsTrimCandidates(block + sibling, H2_DESTINATIONS);
  assert(found.totalEntries === 2 && found.candidates.length === 1, `h${level}: nested content belongs to one entry`);
  const candidate = found.candidates[0];
  assert(candidate?.entryEndLine === block.trimEnd().split("\n").length, `h${level}: range covers every content line`);
  const applied = applyLearningsTrimCandidates(block + sibling, found.candidates);
  assert(applied.learnings.startsWith(`${marker} [MEM-143] → see `), `h${level}: pointer keeps its original heading level`);
  assert(applied.learnings.endsWith(`\n\n${sibling}`), `h${level}: separator and sibling survive byte-for-byte`);
  assert(findLearningsTrimCandidates(applied.learnings, H2_DESTINATIONS).candidates.length === 0, `h${level}: rewritten block is idempotent`);
}

for (const [label, original] of [
  ["adjacent title bullet", "# Learnings\n- Evidence [MEM-143].\n"],
  ["unsupported list", "* Evidence [MEM-143].\n"],
  ["unsupported block with bullets", "####### Unsupported heading [MEM-143]\n\n- Inner evidence [MEM-143].\n"],
  ["unsupported prose", "Evidence [MEM-143].\n"],
  ["fenced content", "## [MEM-143] Code example\n\n```md\n## Fake heading\n- Evidence [MEM-25].\n```\n"],
] as const) {
  const found = findLearningsTrimCandidates(original, H2_DESTINATIONS);
  assert(found.candidates.length === 0, `${label}: ambiguous/unknown format is never proposed`);
  assert(found.skippedEntries.length === 1 && found.skippedEntries[0].reason.length > 0, `${label}: skipped with a reason`);
}

// A corrupted rewrite can shrink and preserve distinct keys while destroying another entry.
const corrupted = bulletPartial.learnings.replace("the suspicious thing was flagged, later cleared.", "destroyed.");
verifyLearningsTrimStats({ ...bulletPartial.stats, bytesAfter: Buffer.byteLength(corrupted) });
let structureThrew = false;
try {
  verifyLearningsTrimStructure(BULLET_LEARNINGS, corrupted, [bulletMem99]);
} catch (err) {
  structureThrew = (err as Error).message.includes("Structural safety check failed");
}
assert(structureThrew, "structure: refuses artificial non-target corruption despite green count checks");
const repeatedSource = "- First lesson [MEM-99].\nWrapped detail stays with the first lesson.\n\n- Second lesson [MEM-99] remains independent.\n";
const repeatedFound = findLearningsTrimCandidates(repeatedSource, BULLET_DESTINATIONS);
const repeatedApplied = applyLearningsTrimCandidates(repeatedSource, repeatedFound.candidates.slice(0, 1));
assert(repeatedApplied.learnings.endsWith("\n\n- Second lesson [MEM-99] remains independent.\n"), "identity: an untargeted entry with the same key survives line shifts byte-for-byte");
let repeatedRefused = false;
try {
  verifyLearningsTrimStructure(repeatedSource, repeatedApplied.learnings.replace("remains independent", "corrupted"), repeatedFound.candidates.slice(0, 1));
} catch { repeatedRefused = true; }
assert(repeatedRefused, "identity: another entry sharing the approved key is still protected");
for (const changed of [
  bulletPartial.learnings.replace("# Learnings", "# Altered preamble"),
  bulletPartial.learnings.replace("- **Correction lesson**", "### **Correction lesson**"),
  bulletPartial.learnings + "unapproved tail",
]) {
  let refused = false;
  try { verifyLearningsTrimStructure(BULLET_LEARNINGS, changed, [bulletMem99]); } catch { refused = true; }
  assert(refused, "structure: protects preamble, boundaries and trailing text");
}
for (const candidate of [
  { ...headingMem163, entryEndLine: headingMem163.entryEndLine - 1 },
  { ...headingMem163, entryEndLine: headingMem163.entryEndLine + 1 },
  { ...headingMem163, entryStartLine: 999 },
  { ...headingMem163, format: "bullet" as const },
]) {
  let refused = false;
  try { applyLearningsTrimCandidates(HEADING_LEARNINGS, [candidate]); } catch { refused = true; }
  assert(refused, "range: apply refuses partial, overlong, missing or mismatched entry ranges");
}
let duplicateRefused = false;
try { applyLearningsTrimCandidates(BULLET_LEARNINGS, [bulletMem99, bulletMem99]); } catch { duplicateRefused = true; }
assert(duplicateRefused, "range: duplicate approvals cannot silently overwrite each other");
let injectedRefused = false;
try { applyLearningsTrimCandidates(BULLET_LEARNINGS, [{ ...bulletMem99, hook: "Injected\n- bogus entry [MEM-99]" }]); } catch {
  injectedRefused = true;
}
assert(injectedRefused, "structure: injected extra entries in a pointer are refused");
const ambiguousEntry = "# Learnings\n- Detail [MEM-99].\n";
let ambiguousRefused = false;
try { applyLearningsTrimCandidates(ambiguousEntry, [{ ...bulletMem99, entryStartLine: 2, entryEndLine: 2 }]); } catch {
  ambiguousRefused = true;
}
assert(ambiguousRefused, "range: manually supplied candidates cannot bypass ambiguity rejection");

// A heading pointer must never become nested under a preceding sibling entry.
const absorption = "## [MEM-200] Preserved parent\n\nDetail.\n\n## [MEM-143] Promoted sibling\n\n" + "Long original narrative. ".repeat(30) + "\n";
const absorptionFound = findLearningsTrimCandidates(absorption, H2_DESTINATIONS);
const absorptionApplied = applyLearningsTrimCandidates(absorption, absorptionFound.candidates);
assert(absorptionApplied.learnings.startsWith("## [MEM-200] Preserved parent\n\nDetail.\n\n## [MEM-143] → see "),
  "structure: heading pointer remains independent of a preceding sibling");
let absorptionRefused = false;
try {
  verifyLearningsTrimStructure(absorption, absorptionApplied.learnings.replace("## [MEM-143] →", "### [MEM-143] →"), absorptionFound.candidates);
} catch (err) {
  absorptionRefused = (err as Error).message.includes("Structural safety check failed");
}
assert(absorptionRefused, "structure: ### stub cannot silently merge into a preceding higher-level heading");

// PB #600 review1: both destructive repros exercise the real write CLI.
const reviewBody = "Long original narrative. ".repeat(30);
const reviewTarget = `## [MEM-99] Target\n\n${reviewBody}`;
const reviewNested = `### [MEM-99] Nested detail\n\n${reviewBody}\n`;
const reviewFixtures: { label: string; before: string; suffix?: string; invalidUtf8?: boolean }[] = [
  // Exact fixtures from both P1 findings (including the original EOF parent).
  ...["##", "#"].map((marker) => ({
    label: `bare ${marker} boundary`,
    before: `${reviewTarget}\n\n${marker}\n\nUNRELATED SECTION MUST SURVIVE\n`,
    suffix: `\n\n${marker}\n\nUNRELATED SECTION MUST SURVIVE\n`,
  })),
  { label: "indented parent exact repro", before: ` ## [MEM-200] Untargeted parent\n\nParent narrative.\n\n${reviewNested}` },
  { label: "BOM parent", before: `\ufeff## [MEM-200] Untargeted parent\n\nParent narrative.\n\n${reviewNested}` },
  ...[1, 2, 3].map((spaces) => ({ label: `${spaces} spaces parent with closing hashes`,
    before: `${" ".repeat(spaces)}## [MEM-200] Untargeted parent ###\n\nParent narrative.\n\n${reviewNested}\n## [MEM-300] Other root\n\nOther narrative.\n` })),
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ label: `bare h${level} parent`,
    before: `${"#".repeat(level)}\n\n- [MEM-99] ${reviewBody}\n` })),
  { label: "BOM title protects descendants", before: `\ufeff# Learnings\n\n${reviewNested}` },
  { label: "empty closing hashes parent", before: `## ###\n\n${reviewNested}` },
  { label: "HTML-comment heading", before: `<!--\n## [MEM-99] Example only\n\n${reviewBody}\n\n## Another example\n\nUNRELATED COMMENT CONTENT\n-->\n` },
  { label: "comment parent owns later nested heading", before: `<!--\n## Untargeted parent\n-->\n\n${reviewNested}` },
  { label: "fenced-code heading", before: `\x60\x60\x60md\n## [MEM-200] Example parent\n\n${reviewNested}\x60\x60\x60\n` },
  { label: "fenced parent owns later nested heading", before: `~~~md\n## Untargeted parent\n~~~\n\n${reviewNested}` },
  // An earlier valid candidate must not be written when later ownership is unknown.
  { label: "unclosed comment refuses whole file", before: `${reviewTarget}\n\n# Other\n\n<!--\n## Unknown ownership\n` },
  { label: "unclosed fence refuses whole file", before: `${reviewTarget}\n\n# Other\n\n~~~md\n## Unknown ownership\n` },
  { label: "unclosed comment without heading", before: `${reviewTarget}\n\n# Other\n\n<!-- unknown\n` },
  { label: "unclosed fence without heading", before: `${reviewTarget}\n\n# Other\n\n\x60\x60\x60md\nunknown\n` },
  { label: "indented boundary ends selected entry", before: `${reviewTarget}\n\n   ## Unrelated ###\n\nUNCHANGED é\t\n`, suffix: "\n\n   ## Unrelated ###\n\nUNCHANGED é\t\n" },
  { label: "closing hashes boundary ends selected entry", before: `${reviewTarget}\n\n## Unrelated ###\n\nUNCHANGED\n`, suffix: "\n\n## Unrelated ###\n\nUNCHANGED\n" },
  { label: "invalid UTF-8 refuses instead of changing unrelated bytes", before: `${reviewTarget}\n\n# Unrelated\n\nKEEP\n`, invalidUtf8: true },
  { label: "CR-only boundaries refuse instead of swallowing unrelated section", before: `${reviewTarget}\n\n##\n\nUNRELATED\n`.replace(/\n/g, "\r") },
];
for (const { label, before, suffix, invalidUtf8 } of reviewFixtures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb600-review1-"));
  try {
    fs.mkdirSync(path.join(root, "memory/core"), { recursive: true });
    fs.mkdirSync(path.join(root, "memory/semantic"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
    const source = path.join(root, "memory/core/LEARNINGS.md");
    const originalBytes = invalidUtf8 ? Buffer.concat([Buffer.from(before), Buffer.from([0xff])]) : Buffer.from(before);
    fs.writeFileSync(source, originalBytes);
    fs.writeFileSync(path.join(root, "memory/semantic/topic.md"), "### Complete promoted incident lesson\nEvidence [MEM-99]\n");
    const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-learnings-trim.ts"), "--apply", "--only", "MEM-99"],
      { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
    const after = fs.readFileSync(source);
    if (suffix) {
      assert(cli.status === 0, `review1 ${label}: safe selection applies: ${cli.stderr}`);
      const expected = `## [MEM-99] → see semantic/topic.md:2 — Complete promoted incident lesson${suffix}`;
      assert(after.equals(Buffer.from(expected)), `review1 ${label}: all unrelated bytes survive exactly`);
    } else {
      assert(cli.status === 1 && cli.stderr.includes("no write performed"), `review1 ${label}: explicit fail-closed refusal: ${cli.stderr}`);
      assert(after.equals(originalBytes), `review1 ${label}: refused file stays byte-identical`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Protected spans release ownership only at a real same-or-higher boundary.
for (const protectedPrefix of [
  " ### Unsupported parent\n\n#### Nested example\n\nProtected prose.\n",
  "\ufeff### Unsupported parent\n\n#### Nested example\n\nProtected prose.\n",
  "<!--\n### Example parent\n-->\n\n#### Nested example\n\nProtected prose.\n",
  "~~~md\n### Example parent\n~~~\n\n#### Nested example\n\nProtected prose.\n",
]) {
  const safe = `${protectedPrefix}\n### [MEM-99] Independent sibling\n\n${reviewBody}\n`;
  const found = findLearningsTrimCandidates(safe, H2_DESTINATIONS);
  assert(found.candidates.length === 1 && found.candidates[0].entryStartLine === protectedPrefix.split("\n").length + 1,
    "review1: only the real sibling after a protected span is eligible");
  const applied = applyLearningsTrimCandidates(safe, found.candidates);
  assert(applied.learnings.startsWith(protectedPrefix + "\n"), "review1: protected parent and descendants survive a sibling rewrite byte-for-byte");
}

// Call the byte verifier directly: it must work without the candidate parser.
const byteSource = `# Learnings\r\n\r\n- [MEM-99] ${reviewBody}\r\n\r\n# Unrelated é\r\n\tKEEP\r\n`;
const byteCandidate = findLearningsTrimCandidates(byteSource, H2_DESTINATIONS).candidates[0];
const byteResult = applyLearningsTrimCandidates(byteSource, [byteCandidate]);
verifyLearningsTrimByteRanges(byteSource, byteResult.learnings, [byteCandidate]);
assert(byteResult.learnings.endsWith("\r\n# Unrelated é\r\n\tKEEP\r\n"), "byte ranges: UTF-8, CRLF, tabs and separators survive");
for (const corrupted of [
  byteResult.learnings.replace("# Learnings", "# Changed"),
  byteResult.learnings.replace("é", "e"),
  byteResult.learnings.replace("\tKEEP", "KEEP"),
  byteResult.learnings.slice(0, -1),
]) {
  let refused = false;
  try { verifyLearningsTrimByteRanges(byteSource, corrupted, [byteCandidate]); } catch { refused = true; }
  assert(refused, "byte ranges: independent verifier refuses changed bytes outside the exact range");
}
for (const [before, candidate] of [
  [`${reviewTarget}\n\n##\n\nUNRELATED\n`, { ...byteCandidate, format: "heading", entryStartLine: 1, entryEndLine: 7 }],
  [` ## Parent\n\n${reviewNested}`, { ...byteCandidate, format: "heading", entryStartLine: 3, entryEndLine: 5 }],
  [`\ufeff## Parent\n\n${reviewNested}`, { ...byteCandidate, format: "heading", entryStartLine: 3, entryEndLine: 5 }],
  [`<!--\n## Parent\n-->\n\n${reviewNested}`, { ...byteCandidate, format: "heading", entryStartLine: 5, entryEndLine: 7 }],
  [`~~~\n## Parent\n~~~\n\n${reviewNested}`, { ...byteCandidate, format: "heading", entryStartLine: 5, entryEndLine: 7 }],
] as [string, LearningsTrimCandidate][]) {
  // Simulate exactly the replacement a regressed candidate parser would approve.
  const lines = before.split("\n");
  const after = [...lines.slice(0, candidate.entryStartLine - 1),
    `### [MEM-99] → see ${candidate.file}:${candidate.line} — ${candidate.hook}`,
    ...lines.slice(candidate.entryEndLine)].join("\n");
  let refused = false;
  try { verifyLearningsTrimByteRanges(before, after, [candidate]); } catch { refused = true; }
  assert(refused, "byte ranges: independently refuses swallowed boundaries and protected descendants with forged parser ranges");
}

console.log(`${passed} assertions passed, ${failed} failed`);
if (failed) process.exitCode = 1;
