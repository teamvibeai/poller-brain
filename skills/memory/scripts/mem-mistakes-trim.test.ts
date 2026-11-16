#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the MISTAKES.md trim + archival logic
 * (poller-brain#328). Mirrors mem-learnings-trim.test.ts's structure and
 * relies on citation-detect.ts's own hardening (index-shaped rejection,
 * multi-key ambiguity, unreliable-hook detection) rather than re-testing
 * it here — see that module's own test coverage for those cases. This
 * file focuses on what's specific to MISTAKES.md: core/LEARNINGS.md as an
 * allowed destination (vs. mem-learnings-trim's blanket core/ exclusion),
 * the core/MISTAKES.md self-citation guard, the archive+pointer apply
 * side effect, and — per DevGuru poller-brain#328 review round 1, run
 * against real MISTAKES.md files across 3 live brains — the entry-format
 * coverage this module actually needs to handle: `##` (the documented
 * convention), `###` (a live brain's actual convention), and top-level
 * `- ` bullets, with body sub-bullets under an open heading never
 * mis-read as sibling entries.
 *
 * Run: npx tsx skills/memory/scripts/mem-mistakes-trim.test.ts
 * Exits non-zero if any assertion fails.
 */

import { runTrimOwnershipTests } from "./test-support/trim-ownership.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  findMistakesTrimCandidates,
  applyMistakesTrimCandidates,
  verifyMistakesTrimStats,
  DEFAULT_ARCHIVE_HEADER,
  type DestinationFile,
  type MistakesTrimCandidate,
} from "./lib/mem-mistakes-trim-core.js";

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
// Suite 1: `##`-heading format (documented convention — skills/memory/
// SKILL.md "MISTAKES.md Entry Format"). Reproduces the real corruption shape
// DevGuru measured on a live 17,977 B brain: a body sub-bullet bears a BARE
// (no-bracket) mention of another MEM-N key, inside an entry that also
// cites its OWN key — the old `###`/`-`-only parser split that bullet out
// as its own "entry"; the fix must keep it as body content of the entry it
// actually belongs to, making that entry correctly multi-key (and thus not
// a trim candidate at all — untouched, no corruption).
// ===========================================================================

const HASH2_MISTAKES = `# Mistakes

## Stale prices in pending decisions (2026-04-16, refinement 2026-05-26)
Proposal generator used a stale cached price instead of a live one. MUST
always verify the live price before proposing anything. [MEM-900]

**Recurrence + tooling root cause:**
- Second incident: proposal generator used a stale strategy.yaml price again.
- validate-rr.ts checks math consistency, NOT input freshness. Same shape as MEM-901 (an earlier, unrelated fabrication bug).
- Tooling fix needed: refresh-prices.ts must run pre-proposal for every pending decision.

## Czenglish instead of native terms (2026-04-10) [MEM-902]
Used a loanword where a native term exists. Rule: never use a loanword when a
native equivalent is available for the whole team's communication.

## Forgot to tag the agent whose reaction was expected (2026-04-16) [MEM-903]
Forgot to tag the agent I wanted a reaction from in a multi-agent thread.
Rule: always tag the specific agent expected to react, or they never see it.
`;

const HASH2_DESTINATIONS: DestinationFile[] = [
  {
    file: "core/LEARNINGS.md",
    text: [
      "### Communication style [MEM-902]",
      "",
      "- **Communication style** — never use a loanword when a native term exists. [MEM-902]",
    ].join("\n"),
  },
];

const hash2Found = findMistakesTrimCandidates(HASH2_MISTAKES, HASH2_DESTINATIONS);

assert(hash2Found.totalEntries === 3, "##: should find exactly 3 top-level `##` entries, not the nested `- ` bullets");
assert(
  hash2Found.multiKeyEntries === 1,
  "##: the 'Stale prices' entry cites BOTH its own MEM-900 and the bare MEM-901 mention in its body — correctly multi-key, not a candidate"
);
assert(
  hash2Found.candidates.length === 1 && hash2Found.candidates[0].key === "MEM-902",
  "##: only MEM-902 (clean single-key, cited in core/LEARNINGS.md) is proposed"
);
assert(hash2Found.candidates[0].marker === "##", "##: candidate records its own literal marker, not forced to `###`");
assert(
  hash2Found.coverageRatio > 0.9,
  `##: recognized entries should cover the near-entirety of a well-formed file (got ${hash2Found.coverageRatio})`
);

const hash2Applied = applyMistakesTrimCandidates(
  HASH2_MISTAKES,
  "",
  hash2Found.candidates,
  "2026-08-20",
  DEFAULT_ARCHIVE_HEADER("2026-H2")
);
const hash2Checks = verifyMistakesTrimStats(hash2Applied.stats);
assert(hash2Applied.stats.trimmedEntries === 1, "##: exactly one entry trimmed");
assert(
  hash2Applied.mistakes.includes("## [MEM-902] → see core/LEARNINGS.md:1 — Communication style"),
  "##: entry rewritten to a `##` pointer — SAME heading level as the original entry, never forced to `###`"
);
assert(
  hash2Applied.mistakes.includes("Same shape as MEM-901"),
  "##: the nested body bullet mentioning MEM-901 survives INSIDE the untouched 'Stale prices' entry — not sliced out as its own archived fragment (the exact real-world corruption DevGuru measured)"
);
assert(
  hash2Applied.mistakes.includes("## Stale prices in pending decisions"),
  "##: the multi-key entry's own heading is completely untouched"
);
assert(
  hash2Applied.mistakes.includes("## Forgot to tag the agent"),
  "##: the never-cited entry is completely untouched"
);
assert(
  hash2Applied.stats.mistakesBytesAfter < hash2Applied.stats.mistakesBytesBefore,
  `##: total MISTAKES.md size shrank (${hash2Applied.stats.mistakesBytesBefore} → ${hash2Applied.stats.mistakesBytesAfter}), not just entry-content — this is the actual invariant Step 9b's trigger cares about`
);
assert(hash2Checks.length > 0, "##: verify checks reported");

// Re-scan: idempotence, and multi-key entry is STILL never a candidate.
const hash2Found2 = findMistakesTrimCandidates(hash2Applied.mistakes, HASH2_DESTINATIONS);
assert(hash2Found2.candidates.length === 0, "##: re-scanning the trimmed file proposes nothing new");
assert(hash2Found2.multiKeyEntries === 1, "##: the untouched multi-key entry is still correctly multi-key on re-scan");

// ===========================================================================
// Suite 2: `###`-heading format — a live brain's actual convention (differs
// from the documented `##`). Marker must be preserved as `###`, not forced.
// ===========================================================================

const HASH3_MISTAKES = `# Mistakes — Corrections to Avoid Repeating

### Blamed the mechanism for what was my own growth, then sat on it for eight days
[MEM-950] — reported a sync "merged but its content never arrived", carried the
claim for a day across multiple memory files, and made it the reason to wait
for a decision to replace the sync mechanism. It was false: origin's own
commit already held the file at the exact expected size — the comparison used
the wrong artifact.

**Why:** two errors stacked — wrong artifact, then a verdict that licensed
inaction instead of one run of the thing that already works.

### Never promoted heading mistake
[MEM-951] — stays untouched, cited nowhere else in this fixture.
`;

const HASH3_DESTINATIONS: DestinationFile[] = [
  {
    file: "semantic/measurement-discipline.md",
    text: [
      "## Measure the right artifact [MEM-950]",
      "",
      "- Before declaring a propagation broken, diff the target against the source in the version it was actually sent, not the version at head. [MEM-950]",
    ].join("\n"),
  },
];

const hash3Found = findMistakesTrimCandidates(HASH3_MISTAKES, HASH3_DESTINATIONS);
assert(hash3Found.totalEntries === 2, "###: should find 2 top-level entries despite multi-line spans");
assert(
  hash3Found.candidates.length === 1 && hash3Found.candidates[0].key === "MEM-950",
  "###: only MEM-950 (cited in semantic/) is proposed"
);
assert(hash3Found.candidates[0].marker === "###", "###: candidate records its own literal `###` marker");

const hash3Applied = applyMistakesTrimCandidates(
  HASH3_MISTAKES,
  "",
  hash3Found.candidates,
  "2026-08-20",
  DEFAULT_ARCHIVE_HEADER("2026-H2")
);
verifyMistakesTrimStats(hash3Applied.stats);
assert(
  hash3Applied.mistakes.includes(
    "### [MEM-950] → see semantic/measurement-discipline.md:1 — Measure the right artifact"
  ),
  "###: entry rewritten to a `###` pointer matching its own entry format, never downgraded to `##`"
);
assert(
  !hash3Applied.mistakes.includes("Blamed the mechanism"),
  "###: the trimmed entry's multi-line body is fully gone, no orphaned remainder"
);
assert(
  hash3Applied.archive.includes("carried the\nclaim for a day"),
  "###: full multi-line original body preserved verbatim in the archive"
);
assert(
  hash3Applied.mistakes.includes("### Never promoted heading mistake"),
  "###: the untouched entry's heading and body remain intact"
);
assert(
  hash3Applied.stats.mistakesBytesAfter < hash3Applied.stats.mistakesBytesBefore,
  "###: total MISTAKES.md size shrank"
);

// ===========================================================================
// Suite 3: flat top-level `- ` bullets, no headings anywhere in the file.
// ===========================================================================

const BULLET_MISTAKES = `# Mistakes

- **Assumed CI green means merged** — treated a green CI run as equivalent to human review approval and referenced it as the merge signal in a status update, which cost a real incident when the PR was actually still pending review. (Source: Jakub, 2026-06-01, [MEM-154])
- **Bounded-field slip** — forgot to ask what is unbounded before assuming a field was capped, leading to an incorrect claim about coverage. (Source: DevGuru, [MEM-93][MEM-94][MEM-122])
- **Never promoted mistake** — stays untouched, cited nowhere. (Source: X, 2026-07-01, [MEM-500])
- [MEM-9] → see episodic/archive/mistakes-2026-H1.md:2 — already trimmed
`;

const BULLET_DESTINATIONS: DestinationFile[] = [
  {
    file: "core/LEARNINGS.md",
    text: [
      "### CI green discipline [MEM-154]",
      "",
      "- **CI green discipline** — CI status and manual review are separate signals, never merge them. [MEM-154]",
    ].join("\n"),
  },
];

const bulletFound = findMistakesTrimCandidates(BULLET_MISTAKES, BULLET_DESTINATIONS);

assert(bulletFound.totalEntries === 4, "bullet: should find 4 top-level entries");
assert(bulletFound.alreadyPointer === 1, "bullet: the [MEM-9] entry is already a pointer");
assert(bulletFound.multiKeyEntries === 1, "bullet: the bounded-field entry (3 keys on one line) is multi-key");
assert(
  bulletFound.candidates.length === 1 && bulletFound.candidates[0].key === "MEM-154",
  "bullet: only MEM-154 (clean single-key, cited in core/LEARNINGS.md) is proposed"
);

const bulletMem154 = bulletFound.candidates[0];
assert(bulletMem154.format === "bullet" && bulletMem154.marker === "-", "bullet: MEM-154 candidate recorded as bullet-format");
assert(bulletMem154.file === "core/LEARNINGS.md" && bulletMem154.line === 1, "bullet: candidate points at core/LEARNINGS.md:1");
assert(bulletMem154.hook === "CI green discipline", "bullet: hook extracted from governing heading");
assert(
  bulletMem154.originalText.includes("Assumed CI green means merged"),
  "bullet: candidate carries the verbatim original entry text for archival"
);

const bulletApplied = applyMistakesTrimCandidates(
  BULLET_MISTAKES,
  "",
  bulletFound.candidates,
  "2026-08-20",
  DEFAULT_ARCHIVE_HEADER("2026-H2")
);
const bulletChecks = verifyMistakesTrimStats(bulletApplied.stats);
assert(bulletApplied.stats.trimmedEntries === 1, "bullet: exactly one entry trimmed");
assert(
  bulletApplied.mistakes.includes(
    "- [MEM-154] → see core/LEARNINGS.md:1 — CI green discipline (Source: Jakub, 2026-06-01)"
  ),
  "bullet: entry rewritten to a pointer in the SAME short format as Step 5d — destination only, no per-entry archive annotation"
);
assert(
  !bulletApplied.mistakes.includes("cost a real incident"),
  "bullet: the trimmed entry's original prose is gone from MISTAKES.md"
);
assert(
  bulletApplied.mistakes.includes("**Bounded-field slip**"),
  "bullet: multi-key entry is never a candidate, left untouched"
);
assert(
  bulletApplied.mistakes.includes("**Never promoted mistake**"),
  "bullet: MEM-500 (never cited anywhere) left completely untouched"
);
assert(
  bulletApplied.mistakes.includes("- [MEM-9] → see episodic/archive/mistakes-2026-H1.md:2 — already trimmed"),
  "bullet: pre-existing pointer entry left completely untouched"
);
assert(
  bulletApplied.archive.includes("Archived 2026-08-20 — superseded by core/LEARNINGS.md:1 [MEM-154]"),
  "bullet: archive gets a provenance header for the relocated entry"
);
assert(
  bulletApplied.archive.includes("Assumed CI green means merged") && bulletApplied.archive.includes("cost a real incident"),
  "bullet: archive preserves the FULL original entry text verbatim — nothing lost, only relocated"
);
assert(
  bulletApplied.stats.mistakesBytesAfter < bulletApplied.stats.mistakesBytesBefore,
  `bullet: total MISTAKES.md size shrank (${bulletApplied.stats.mistakesBytesBefore} → ${bulletApplied.stats.mistakesBytesAfter}) despite the one-time stub cost`
);
assert(bulletApplied.stats.archiveBytesAfter > bulletApplied.stats.archiveBytesBefore, "bullet: archive grew");
assert(bulletChecks.length > 0, "bullet: verify checks reported");
assert(
  bulletApplied.mistakes.includes(
    "> 📦 1 mistake archived — full original text in `memory/episodic/archive/mistakes-*.md` (grep for the key) — Keys: MEM-154"
  ),
  "bullet: the aggregate stub counts ONLY the key this run actually archived — the pre-existing [MEM-9] pointer (never archived by this run, this run's `archive` param started empty) is correctly EXCLUDED, not falsely claimed as archived (DevGuru poller-brain#328 round 1 NIT1)"
);

// Re-scan: idempotence.
const bulletFound2 = findMistakesTrimCandidates(bulletApplied.mistakes, BULLET_DESTINATIONS);
assert(bulletFound2.candidates.length === 0, "bullet: re-scanning the trimmed MISTAKES.md proposes nothing new");
assert(bulletFound2.alreadyPointer === 2, "bullet: run 2 finds both trimmed/pre-existing entries as already-pointers");

// Re-applying with an empty candidate list against the already-updated archive must not duplicate the archived entry.
const bulletApplied2 = applyMistakesTrimCandidates(
  bulletApplied.mistakes,
  bulletApplied.archive,
  [],
  "2026-08-21",
  DEFAULT_ARCHIVE_HEADER("2026-H2")
);
assert(bulletApplied2.mistakes === bulletApplied.mistakes, "bullet: a second apply pass with no new candidates is byte-identical");
assert(bulletApplied2.archive === bulletApplied.archive, "bullet: archive is untouched on a no-candidate re-run");

// ===========================================================================
// Suite 4: coverage-ratio guard — an entry-format the parser does NOT
// recognize (bold-prefixed paragraphs, no `##`/`###`/top-level `- `) must
// report a low coverageRatio even when totalEntries > 0, because a single
// incidental `- ` bullet inside one paragraph still gets picked up as its
// own (tiny) bullet-entry. This is what the CLI's format-mismatch guard
// keys on instead of the old, narrower `totalEntries === 0` signal
// (DevGuru poller-brain#328 round 1 B2c).
//
// KNOWN LIMITATION the fixture placement below deliberately works around:
// an entry's span always runs to the NEXT recognized start or EOF, so a
// stray bullet near the START of the file balloons to cover nearly the
// whole file (high coverageRatio, guard blind) even though almost none of
// that span is actually recognized-format content — only a stray bullet
// near the END of the file yields the low ratio this guard is meant to
// catch. Caught while wiring this test up for real (self-caught, not from
// review): coverageRatio is a real but position-dependent signal, not a
// content-density one. Documented here rather than silently fixed by
// picking a favorable position, since the guard's blind spot is real.
// ===========================================================================

const UNRECOGNIZED_FORMAT_MISTAKES =
  "# Mistakes\n\n" +
  Array.from({ length: 22 }, (_, i) => {
    const body =
      `**Incident ${i} (2026-0${(i % 9) + 1}-01)** — root cause was a stale cache read that skipped the ` +
      `freshness check before use; the documented fix here cites MEM-${2000 + i} as the tracked lesson for ` +
      `this incident, which recurred more than once before being caught.\n`;
    const strayBullet = i === 20 ? "- an unrelated aside mentioning MEM-9999 in passing\n" : "";
    return body + strayBullet;
  }).join("\n");

const unrecognizedFound = findMistakesTrimCandidates(UNRECOGNIZED_FORMAT_MISTAKES, []);
assert(
  Buffer.byteLength(UNRECOGNIZED_FORMAT_MISTAKES) > 5000,
  "coverage-guard fixture must be over the 5000B cap to be a realistic mismatch scenario"
);
assert(
  unrecognizedFound.totalEntries === 1,
  "coverage-guard: exactly one entry recognized (the single stray top-level `- ` bullet) — NOT zero, so a `totalEntries === 0` guard alone would miss this"
);
assert(
  unrecognizedFound.coverageRatio < 0.5,
  `coverage-guard: the one recognized entry (a stray bullet near the END of a 22-paragraph file, so its span stays short) covers only a tiny fraction (got ${unrecognizedFound.coverageRatio}) — this is the signal the CLI's format-mismatch guard checks`
);

// ===========================================================================
// Cross-cutting invariants
// ===========================================================================

// --- self-citation guard: core/MISTAKES.md must never be a destination ---
let selfThrew = false;
try {
  findMistakesTrimCandidates(BULLET_MISTAKES, [{ file: "core/MISTAKES.md", text: BULLET_MISTAKES }]);
} catch {
  selfThrew = true;
}
assert(
  selfThrew,
  "findMistakesTrimCandidates throws when a destination is core/MISTAKES.md itself, rather than spuriously self-citing"
);

// --- core/LEARNINGS.md as a destination is explicitly ALLOWED here (the
// opposite of mem-learnings-trim-core.ts, which excludes all of core/) ---
let learningsDestThrew = false;
try {
  findMistakesTrimCandidates(BULLET_MISTAKES, BULLET_DESTINATIONS); // BULLET_DESTINATIONS uses core/LEARNINGS.md
} catch {
  learningsDestThrew = true;
}
assert(!learningsDestThrew, "core/LEARNINGS.md as a destination does not throw — it is a legitimate promotion target for a mistake");

// --- verifyMistakesTrimStats FAIL LOUD on entry-content growth ---
let growThrew = false;
try {
  verifyMistakesTrimStats({
    totalEntries: 1,
    alreadyPointer: 0,
    candidateEntries: 1,
    trimmedEntries: 1,
    trimmedKeys: ["MEM-1"],
    mistakesBytesBefore: 100,
    mistakesBytesAfter: 150,
    stubBytesBefore: 0,
    stubBytesAfter: 0,
    archiveBytesBefore: 0,
    archiveBytesAfter: 50,
    distinctKeysBefore: 1,
    distinctKeysAfter: 1,
    archivedKeys: ["MEM-1"],
  });
} catch {
  growThrew = true;
}
assert(growThrew, "verifyMistakesTrimStats throws when MISTAKES.md entry content grows (no stub involved here)");

// --- verifyMistakesTrimStats FAIL LOUD when TOTAL size doesn't shrink,
// even if that's solely because a first-time stub outweighs one entry's
// savings — DevGuru poller-brain#328 round 1 TO-FIX 1: the step's own
// trigger (Step 9b) is TOTAL file size, so a run that reports trimmed
// entries but leaves the file the same size or bigger must fail loud, not
// print a misleadingly narrow "entry content: no growth ✅". (The real
// "stub overhead doesn't kill a realistic trim's savings" property is
// covered by the apply-path integration tests above, which are sized to
// hold.)
let totalNoShrinkThrew = false;
try {
  verifyMistakesTrimStats({
    totalEntries: 1,
    alreadyPointer: 0,
    candidateEntries: 1,
    trimmedEntries: 1,
    trimmedKeys: ["MEM-1"],
    mistakesBytesBefore: 100,
    mistakesBytesAfter: 130, // total grew...
    stubBytesBefore: 0,
    stubBytesAfter: 60, // ...entirely because of a new 60-byte stub — entry content went 100 → 70
    archiveBytesBefore: 0,
    archiveBytesAfter: 50,
    distinctKeysBefore: 1,
    distinctKeysAfter: 1,
    archivedKeys: ["MEM-1"],
  });
} catch {
  totalNoShrinkThrew = true;
}
assert(
  totalNoShrinkThrew,
  "verifyMistakesTrimStats throws when total size does not shrink despite trimmed entries, even if stub-excluded entry content did shrink"
);

// --- verifyMistakesTrimStats FAIL LOUD on archive shrinkage ---
let shrinkThrew = false;
try {
  verifyMistakesTrimStats({
    totalEntries: 1,
    alreadyPointer: 0,
    candidateEntries: 1,
    trimmedEntries: 1,
    trimmedKeys: ["MEM-1"],
    mistakesBytesBefore: 100,
    mistakesBytesAfter: 50,
    stubBytesBefore: 0,
    stubBytesAfter: 0,
    archiveBytesBefore: 200,
    archiveBytesAfter: 100, // archive shrank — must throw
    distinctKeysBefore: 1,
    distinctKeysAfter: 1,
    archivedKeys: ["MEM-1"],
  });
} catch {
  shrinkThrew = true;
}
assert(shrinkThrew, "verifyMistakesTrimStats throws when the archive shrinks — archival must never lose content");

// --- verifyMistakesTrimStats FAIL LOUD on a lost key ---
let keyLostThrew = false;
try {
  verifyMistakesTrimStats({
    totalEntries: 1,
    alreadyPointer: 0,
    candidateEntries: 1,
    trimmedEntries: 1,
    trimmedKeys: ["MEM-1"],
    mistakesBytesBefore: 100,
    mistakesBytesAfter: 80,
    stubBytesBefore: 0,
    stubBytesAfter: 0,
    archiveBytesBefore: 0,
    archiveBytesAfter: 50,
    distinctKeysBefore: 5,
    distinctKeysAfter: 4,
    archivedKeys: ["MEM-1"],
  });
} catch {
  keyLostThrew = true;
}
assert(keyLostThrew, "verifyMistakesTrimStats throws when a distinct MEM-N key is lost across the trim");

// --- applyMistakesTrimCandidates guards against a stale candidate list ---
const STALE_MISTAKES = `# Mistakes

- **Unrelated entry, not MEM-154** — nothing to do with the stale candidate. (Source: Q, [MEM-777])
`;
const staleCandidate: MistakesTrimCandidate = {
  key: "MEM-154",
  format: "bullet",
  marker: "-",
  entryStartLine: 3,
  entryEndLine: 3,
  file: "core/LEARNINGS.md",
  line: 1,
  lineText: "stale citation",
  hook: "stale hook",
  originalText: "- **Unrelated entry, not MEM-154** — nothing to do with the stale candidate. (Source: Q, [MEM-777])",
};
let staleThrew = false;
try {
  applyMistakesTrimCandidates(
    STALE_MISTAKES,
    "",
    [staleCandidate],
    "2026-08-20",
    DEFAULT_ARCHIVE_HEADER("2026-H2")
  );
} catch {
  staleThrew = true;
}
assert(
  staleThrew,
  "applyMistakesTrimCandidates throws instead of overwriting an entry that doesn't actually cite the candidate's key"
);

// Mixed pointer markers and archive provenance keep dated identities intact.
const DATED_A = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DATED_B = "MEM-2026-11-07-203001-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";

const mixedMistakePointers = findMistakesTrimCandidates([
  `- [${DATED_A}] → see semantic/one.md:1 — Already promoted rule`,
  "- [MEM-12] → see semantic/legacy.md:1 — Legacy promoted rule",
  `## [${DATED_B}:obsolete] → see semantic/two.md:1 — Another promoted rule`,
].join("\n"), []);
assert(mixedMistakePointers.alreadyPointer === 3, "MISTAKES recognises dated and legacy bullet/heading pointers");
const datedMistake = `- **Important dated mistake** — ${"Original incident detail worth preserving. ".repeat(12)} (Source: incident, [${DATED_A}])\n`;
const datedDest = [{ file: "core/LEARNINGS.md", text: `### Stable dated lesson heading [${DATED_A}]\nCondensed lesson [${DATED_A}]` }];
const datedMistakeFound = findMistakesTrimCandidates(datedMistake, datedDest);
assert(datedMistakeFound.candidates[0]?.key === DATED_A, "MISTAKES extracts whole dated identity");
const datedMistakeApplied = applyMistakesTrimCandidates(datedMistake, "", datedMistakeFound.candidates, "2026-11-07", DEFAULT_ARCHIVE_HEADER("2026-H2"));
assert(datedMistakeApplied.mistakes.startsWith(`- [${DATED_A}] → see `), "MISTAKES writes full dated pointer");
assert(datedMistakeApplied.mistakes.includes("(Source: incident)"), "MISTAKES removes redundant dated provenance tag");
assert(datedMistakeApplied.archive.includes(datedMistake.trim()), "MISTAKES archives original dated entry verbatim");
assert(datedMistakeApplied.mistakes.includes(`Keys: ${DATED_A}`), "dated archive pointer lookup builds stub");
assert(datedMistakeApplied.stats.distinctKeysBefore === 1 && datedMistakeApplied.stats.distinctKeysAfter === 1, "MISTAKES dated identity count preserved");
const repeatDated = applyMistakesTrimCandidates(datedMistakeApplied.mistakes, datedMistakeApplied.archive, [], "2026-11-07", DEFAULT_ARCHIVE_HEADER("2026-H2"));
assert(repeatDated.mistakes === datedMistakeApplied.mistakes && repeatDated.archive === datedMistakeApplied.archive, "dated MISTAKES pointer/archive lookup is idempotent");
const multiMistake = findMistakesTrimCandidates(`- Mixed incident [${DATED_A}] [${DATED_B}]`, datedDest);
assert(multiMistake.multiKeyEntries === 1 && multiMistake.candidates.length === 0, "two same-year dated mistake keys never collapse");
const mistakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-id-mistakes-"));
try {
  fs.mkdirSync(path.join(mistakeRoot, "memory/core"), { recursive: true });
  fs.writeFileSync(path.join(mistakeRoot, "CLAUDE.md"), "fixture");
  fs.writeFileSync(path.join(mistakeRoot, "memory/core/MISTAKES.md"), datedMistake);
  fs.writeFileSync(path.join(mistakeRoot, "memory/core/LEARNINGS.md"), datedDest[0].text);
  const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-mistakes-trim.ts"), "--apply", "--only", DATED_A],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: mistakeRoot } });
  assert(cli.status === 0, `MISTAKES --only dated ID finds candidate: ${cli.stderr}`);
  assert(fs.readFileSync(path.join(mistakeRoot, "memory/core/MISTAKES.md"), "utf8").startsWith(`- [${DATED_A}] → see `), "MISTAKES CLI preserves full ID");
} finally {
  fs.rmSync(mistakeRoot, { recursive: true, force: true });
}

// Lifecycle-tagged destination headings remain ineligible, as on 0ce65634.
// Exercise the real apply CLI: rejection must preserve the source bytes.
for (const key of ["MEM-1", DATED_A]) {
  const original = `- [${key}:obsolete] ${"Original superseded memo, kept for one consolidation cycle. ".repeat(40)}\n`;
  const destination = `### Preserve the complete original lesson [${key}:obsolete]\n\nSuperseded promoted narrative [${key}:obsolete]\n`;
  const found = findMistakesTrimCandidates(original, [{ file: "semantic/topic.md", text: destination }]);
  assert(found.candidates.length === 0, `MISTAKES lifecycle-tagged heading is ineligible: ${key}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-obsolete-mistakes-"));
  try {
    fs.mkdirSync(path.join(root, "memory/core"), { recursive: true });
    fs.mkdirSync(path.join(root, "memory/semantic"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
    const source = path.join(root, "memory/core/MISTAKES.md");
    fs.writeFileSync(source, original);
    fs.writeFileSync(path.join(root, "memory/semantic/topic.md"), destination);
    const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-mistakes-trim.ts"), "--apply", "--only", key],
      { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
    assert(cli.status === 1, `MISTAKES CLI rejects lifecycle-tagged destination: ${key}`);
    assert(fs.readFileSync(source, "utf8") === original, `MISTAKES CLI preserves obsolete source byte-for-byte: ${key}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

runTrimOwnershipTests("mistakes", assert);

// ===========================================================================
// Issue #463: category containers, heading-owned body bullets, and unresolved
// ownership. These fixtures are synthetic; the issue supplied no source file.
// ===========================================================================

const detail = "The incident repeated because stale evidence was accepted before the freshness check. ";
const groupedFlat = `- [MEM-619] Flat mistake before any category. ${detail.repeat(8)}`;
const groupedLegacy = `- **Stale evidence** [MEM-610] ${detail.repeat(50)}\n  Continued incident detail, including non-ASCII text: příčina.\n  - Indented supporting detail belongs to this entry.`;
const groupedDated = `- [${DATED_B}] Another independent incident. ${detail.repeat(8)}\n  Continuation retained with its own entry.`;
const groupedMissing = "- [MEM-612] No promotion evidence; preserve this sibling.\n  Preserve this continuation too.";
const groupedMulti = "- [MEM-613] One incident also references MEM-614; keep single-key rejection.";
const groupedIndex = "- [MEM-615] Listed only in an index, never promoted.";
const groupedUnreliable = "- [MEM-616] Destination lacks a governing heading.";
const groupedSemantic = `- [MEM-617] Eligible but unapproved sibling. ${detail.repeat(6)}`;
const groupedHeading = "### Actual incident [MEM-620]\nIncident prose belongs to the heading.\n- Supporting detail mentioning [MEM-621] is not a sibling.";
const GROUPED = [
  "# Mistakes", "", groupedFlat, "", "## Operations", "", groupedLegacy,
  "", groupedDated, groupedMissing, groupedMulti, groupedIndex, groupedUnreliable,
  "", "### Communication", "", groupedSemantic, "", groupedHeading, "",
].join("\n");
const GROUPED_DESTINATIONS: DestinationFile[] = [
  { file: "core/LEARNINGS.md", text: `### Fresh evidence discipline\nUse fresh evidence [MEM-610]\nUse current evidence [${DATED_B}]\n| [MEM-615] | semantic/reference.md |` },
  { file: "semantic/communication.md", text: "## Preserve communication context\nRetain context [MEM-617]" },
  { file: "procedural/check.md", text: "## Check before reporting\nCheck the result [MEM-619]\nRelated incident [MEM-621]" },
  { file: "semantic/no-heading.md", text: "A lesson without a reliable heading [MEM-616]" },
];
const groupedFound = findMistakesTrimCandidates(GROUPED, GROUPED_DESTINATIONS);
assert(groupedFound.totalEntries === 9, "grouped: category headings are containers, with nine real entries");
assert(groupedFound.structuralDiagnostics.length === 0, "grouped: every bullet has a resolved entry owner");
assert(groupedFound.candidates.map((c) => c.key).join(",") === `MEM-610,MEM-617,MEM-619,${DATED_B}`, "grouped: eligible legacy/dated bullets use all three destination types");
assert(groupedFound.multiKeyEntries === 2, "grouped: multi-key bullet and genuine heading remain ineligible");
assert(groupedFound.indexRejections.some((r) => r.key === "MEM-615"), "grouped: index-only destination remains ineligible");
assert(groupedFound.unreliableHooks.some((r) => r.key === "MEM-616"), "grouped: unreliable destination remains ineligible");
const groupedCandidate = groupedFound.candidates.find((c) => c.key === "MEM-610")!;
assert(groupedCandidate.originalText === groupedLegacy, "grouped: original includes continuation and indented body bullet verbatim");
assert(groupedCandidate.entryStartLine === GROUPED.split("\n").indexOf(groupedLegacy.split("\n")[0]) + 1, "grouped: candidate starts on the actual bullet line");
const groupedApplied = applyMistakesTrimCandidates(GROUPED, "", [groupedCandidate], "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
const groupedChecks = verifyMistakesTrimStats(groupedApplied.stats);
assert(groupedChecks.length > 0 && groupedApplied.stats.distinctKeysBefore === 11 && groupedApplied.stats.distinctKeysAfter === 11, "grouped: shared boundaries preserve every distinct key");
const groupedPointer = "- [MEM-610] → see core/LEARNINGS.md:2 — Fresh evidence discipline";
const expectedGroupedBody = GROUPED.replace(groupedLegacy, groupedPointer).trimEnd();
assert(groupedApplied.mistakes.split("\n\n> 📦")[0] === expectedGroupedBody, "grouped: exact category text, separators, markers, and all untouched siblings survive");
assert(groupedApplied.archive.includes(`\n${groupedLegacy}\n`), "grouped: archive retains the complete original entry verbatim");
assert(!groupedApplied.archive.includes(groupedDated) && !groupedApplied.archive.includes("## Operations"), "grouped: archive contains only the approved entry, not its category or siblings");
assert(groupedApplied.stats.mistakesBytesAfter < groupedApplied.stats.mistakesBytesBefore, "grouped: total bytes shrink after approved-subset apply");
const groupedRescan = findMistakesTrimCandidates(groupedApplied.mistakes, GROUPED_DESTINATIONS);
assert(groupedRescan.alreadyPointer === 1 && groupedRescan.candidates.length === 3 && groupedRescan.structuralDiagnostics.length === 0, "grouped: re-scan resolves pointers and still proposes unapproved eligible siblings");
const groupedRepeat = applyMistakesTrimCandidates(groupedApplied.mistakes, groupedApplied.archive, [], "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
assert(groupedRepeat.mistakes === groupedApplied.mistakes && groupedRepeat.archive === groupedApplied.archive, "grouped: repeat apply with no newly approved entries is byte-identical");
const datedGroupedCandidate = groupedRescan.candidates.find((c) => c.key === DATED_B)!;
const datedGroupedApplied = applyMistakesTrimCandidates(groupedApplied.mistakes, groupedApplied.archive, [datedGroupedCandidate], "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
verifyMistakesTrimStats(datedGroupedApplied.stats);
const datedGroupedRescan = findMistakesTrimCandidates(datedGroupedApplied.mistakes, GROUPED_DESTINATIONS);
assert(datedGroupedRescan.alreadyPointer === 2 && datedGroupedRescan.structuralDiagnostics.length === 0, "grouped: dated and legacy pointers remain resolved under their category on re-scan");
assert(datedGroupedApplied.archive.includes(`\n${groupedDated}\n`), "grouped: dated entry continuation archived verbatim");

// Either heading level and either identity location must retain supporting
// bullets, including bracketed cross-references and bare key mentions.
for (const marker of ["##", "###"]) {
  for (const identityInTitle of [false, true]) {
    const text = `${marker} Genuine incident${identityInTitle ? " [MEM-630]" : ""}\nIntroductory incident prose${identityInTitle ? "" : " [MEM-630]"}.\n- Supporting detail [MEM-631]\n- Another detail mentioning MEM-632\n`;
    const found = findMistakesTrimCandidates(text, [{ file: "semantic/lesson.md", text: "## Proper supporting lesson\nRestatement [MEM-631]" }]);
    assert(found.totalEntries === 1 && found.multiKeyEntries === 1 && found.candidates.length === 0 && found.structuralDiagnostics.length === 0, `${marker}, identityInTitle=${identityInTitle}: body keys have a resolved heading owner, never become candidates`);
  }
}

// Empty category headings and nested heading entries preserve their own
// markers, even when only the child incident is trimmed.
const nestedHeading = `### Child incident [MEM-640]\n${detail.repeat(10)}`;
const nested = `## Category\n\n${nestedHeading}\n\n## Empty category\n`;
const nestedFound = findMistakesTrimCandidates(nested, [{ file: "semantic/lesson.md", text: "## Fresh nested lesson\nRestatement [MEM-640]" }]);
const nestedApplied = applyMistakesTrimCandidates(nested, "", nestedFound.candidates, "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
verifyMistakesTrimStats(nestedApplied.stats);
assert(nestedFound.totalEntries === 1 && nestedApplied.mistakes.startsWith("## Category\n\n### [MEM-640] → see ") && nestedApplied.mistakes.includes("\n\n## Empty category\n"), "nested: parent category and following empty category survive a child heading trim");

// Prose with no identity, an unkeyed supporting bullet, and a bare heading
// reference all leave ownership unresolved, independently of byte coverage.
const ambiguousSections = [
  "## Unresolved prose\nIncident prose with no own identity.\n- [MEM-650] May belong to the prose above.\n  Continuation must stay.",
  "### Unresolved bullets\n\n- Supporting detail with no key\n- [MEM-650] May be a sibling or supporting detail.",
  "## Related to MEM-649\n\n- [MEM-650] A bare heading reference alone cannot establish ownership.",
  "## Late identity\n\n- Unkeyed bullet first\n  Identity appears only in continuation [MEM-650]",
];
for (const section of ambiguousSections) {
  const found = findMistakesTrimCandidates(section, GROUPED_DESTINATIONS);
  assert(found.candidates.length === 0 && found.structuralDiagnostics.length === 1, "ambiguous: unresolved section is skipped and reported");
  const expectedLines = section.split("\n").flatMap((line, i) => line.startsWith("- [MEM-650]") ? [i + 1] : []);
  assert(JSON.stringify(found.structuralDiagnostics[0].keyedBulletLines) === JSON.stringify(expectedLines), "ambiguous: diagnostics identify exact unresolved keyed bullet starts");
}
const ambiguous = ambiguousSections[0];
const highCoverageAmbiguous = `## Real incident [MEM-660]\n${detail.repeat(100)}\n\n${ambiguous}\n`;
const highFound = findMistakesTrimCandidates(highCoverageAmbiguous, []);
assert(highFound.coverageRatio > 0.9 && highFound.structuralDiagnostics.length === 1, "ambiguous: high byte coverage cannot hide unresolved bullet ownership");
const lowCoverageAmbiguous = `${"Unsupported prose. ".repeat(400)}\n${ambiguous}\n`;
const lowFound = findMistakesTrimCandidates(lowCoverageAmbiguous, []);
assert(lowFound.coverageRatio < 0.5 && lowFound.structuralDiagnostics.length === 1, "ambiguous: structural diagnostics accompany low byte coverage");

// A candidate from a heading-free scan must never be silently accepted once
// its bullet becomes part of an unresolved section.
const formerlyFlat = "# Mistakes\n\n- [MEM-650] May belong to the prose above.\n  Continuation must stay.";
const ambiguityDest = [{ file: "semantic/lesson.md", text: "## Reliable promoted lesson\nRestatement [MEM-650]" }];
const formerlyFlatFound = findMistakesTrimCandidates(formerlyFlat, ambiguityDest);
let ambiguousApplyThrew = false;
try {
  applyMistakesTrimCandidates(ambiguous, "", formerlyFlatFound.candidates, "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
} catch {
  ambiguousApplyThrew = true;
}
assert(formerlyFlatFound.candidates.length === 1 && ambiguousApplyThrew, "ambiguous: core apply rejects a candidate whose boundary no longer resolves");

// Exercise propose, approved-subset apply, and repeat apply through the CLI
// against scratch brains, verifying on-disk source and archive bytes.
function withMistakeFixture(source: string, destinations: DestinationFile[], run: (root: string, sourcePath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-mistakes-grouped-"));
  try {
    fs.mkdirSync(path.join(root, "memory/core"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
    const sourcePath = path.join(root, "memory/core/MISTAKES.md");
    fs.writeFileSync(sourcePath, source);
    for (const dest of destinations) {
      const destPath = path.join(root, "memory", dest.file);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, dest.text);
    }
    run(root, sourcePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function runMistakeCli(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-mistakes-trim.ts"), ...args],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
}
withMistakeFixture(GROUPED, GROUPED_DESTINATIONS, (root, sourcePath) => {
  const propose = runMistakeCli(root);
  assert(propose.status === 0 && propose.stdout.includes("candidates=4"), `grouped CLI: proposes individual entries: ${propose.stderr}`);
  assert(fs.readFileSync(sourcePath, "utf8") === GROUPED && !fs.existsSync(path.join(root, "memory/episodic")), "grouped CLI: propose writes neither source nor archive");
  const apply = runMistakeCli(root, ["--apply", "--only", "MEM-610"]);
  assert(apply.status === 0 && apply.stdout.includes("trimmed:        MEM-610"), `grouped CLI: applies only approved subset: ${apply.stderr}`);
  const after = fs.readFileSync(sourcePath, "utf8");
  assert(after === groupedApplied.mistakes, "grouped CLI: disk source matches exact expected layout and untouched siblings");
  const archiveDir = path.join(root, "memory/episodic/archive");
  const archiveFile = path.join(archiveDir, fs.readdirSync(archiveDir)[0]);
  const archive = fs.readFileSync(archiveFile, "utf8");
  assert(archive.includes(`\n${groupedLegacy}\n`) && !archive.includes(groupedDated), "grouped CLI: disk archive contains approved entry verbatim");
  assert(Buffer.byteLength(after) < Buffer.byteLength(GROUPED), "grouped CLI: source size shrinks");
  const repeat = runMistakeCli(root, ["--apply", "--only", "MEM-610"]);
  assert(repeat.status === 1 && fs.readFileSync(sourcePath, "utf8") === after && fs.readFileSync(archiveFile, "utf8") === archive, "grouped CLI: repeat approval of an existing pointer leaves source and archive byte-identical");
});
for (const source of [ambiguous, highCoverageAmbiguous, lowCoverageAmbiguous]) {
  withMistakeFixture(source, ambiguityDest, (root, sourcePath) => {
    const propose = runMistakeCli(root);
    const expectedLines = findMistakesTrimCandidates(source, []).structuralDiagnostics[0].keyedBulletLines.join(", ");
    assert(propose.status === 0 && propose.stderr.includes("Investigate unresolved entry ownership") && propose.stderr.includes(`(lines): ${expectedLines}.`) && !propose.stdout.includes("No-op."), "ambiguous CLI: investigation warning with line numbers replaces clean no-op at any size/coverage");
    const apply = runMistakeCli(root, ["--apply", "--only", "MEM-650"]);
    assert(apply.status === 1 && fs.readFileSync(sourcePath, "utf8") === source && !fs.existsSync(path.join(root, "memory/episodic")), "ambiguous CLI: affected span cannot be applied or archived");
    if (source === lowCoverageAmbiguous) {
      assert(propose.stderr.includes("entry-format mismatch") && apply.stderr.includes("entry-format mismatch"), "ambiguous CLI: existing MIN_COVERAGE_RATIO guard still runs on propose and apply");
    }
  });
}
// Unaffected entries may still be approved while unresolved spans are intact.
const safeWithAmbiguous = `## Safe incident [MEM-610]\n${detail.repeat(50)}\n\n${ambiguous}\n\n> 📦 1 mistake archived — full original text in \`memory/episodic/archive/mistakes-*.md\` (grep for the key) — Keys: MEM-999\n`;
withMistakeFixture(safeWithAmbiguous, GROUPED_DESTINATIONS, (root, sourcePath) => {
  const propose = runMistakeCli(root);
  assert(propose.stdout.includes("1 trim candidate(s)") && propose.stderr.includes("Investigate"), "mixed ambiguity: safe candidates remain reviewable beside structural warnings");
  const apply = runMistakeCli(root, ["--apply", "--only", "MEM-610"]);
  const after = fs.readFileSync(sourcePath, "utf8");
  assert(apply.status === 0 && after.includes(ambiguous), `mixed ambiguity: safe apply preserves affected span exactly: ${apply.stderr}`);
  assert(apply.stdout.includes("2 distinct MEM-N keys preserved"), "mixed ambiguity: accounting includes unresolved keys and excludes aggregate stub keys");
});

// Review #463: different originals sharing a key must never be shortened.
// Archival deduplicates by key, so proposing both would silently lose one.
const duplicateFirst = `- [MEM-610] First incident: ${detail.repeat(12)}`;
const duplicateSecond = `- [MEM-610] Second incident: independent handover failure. ${"The handover omitted validation and its separate remediation. ".repeat(25)}`;
const duplicateCategory = `# Mistakes\n\n## Operations\n\n${duplicateFirst}\n\n${duplicateSecond}\n`;
const duplicateFound = findMistakesTrimCandidates(duplicateCategory, GROUPED_DESTINATIONS);
assert(duplicateFound.candidates.length === 0, "duplicate key: neither distinct original is proposed");
for (const original of [duplicateFirst, duplicateSecond]) {
  const startLine = duplicateCategory.split("\n").indexOf(original) + 1;
  assert(duplicateFound.structuralDiagnostics.some((d) => d.startLine === startLine && d.endLine === startLine && d.keyedBulletLines.includes(startLine) && d.reason.includes("MEM-610")), "duplicate key: diagnostics identify each affected entry span and key");
}

// Control: changing just the second key restores both candidates and keeps
// every original verbatim in the archive. Its first candidate also exercises
// apply-time revalidation when a duplicate is introduced after proposal.
const uniqueCategory = duplicateCategory.replace("- [MEM-610] Second incident:", "- [MEM-617] Second incident:");
const uniqueFound = findMistakesTrimCandidates(uniqueCategory, GROUPED_DESTINATIONS);
assert(uniqueFound.candidates.map((c) => c.key).join(",") === "MEM-610,MEM-617", "unique control: both category bullets remain candidates");
const uniqueApplied = applyMistakesTrimCandidates(uniqueCategory, "", uniqueFound.candidates, "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
verifyMistakesTrimStats(uniqueApplied.stats);
assert(uniqueApplied.stats.trimmedEntries === 2 && uniqueFound.candidates.every((c) => uniqueApplied.archive.includes(`\n${c.originalText}\n`)), "unique control: both full originals archived and shortened");
const mixedDuplicates = `${duplicateCategory}\n- [MEM-617] Unrelated safe incident. ${detail.repeat(12)}\n`;
const mixedFound = findMistakesTrimCandidates(mixedDuplicates, GROUPED_DESTINATIONS);
assert(mixedFound.candidates.map((c) => c.key).join(",") === "MEM-617", "duplicate key: unrelated unique sibling remains eligible");
const mixedApplied = applyMistakesTrimCandidates(mixedDuplicates, "", mixedFound.candidates, "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
verifyMistakesTrimStats(mixedApplied.stats);
assert([duplicateFirst, duplicateSecond].every((original) => mixedApplied.mistakes.includes(original) && !mixedApplied.archive.includes(original)), "duplicate key: safe sibling apply leaves both duplicate originals intact");
let duplicateApplyThrew = false;
try {
  applyMistakesTrimCandidates(duplicateCategory, "", [uniqueFound.candidates[0]], "2026-11-15", DEFAULT_ARCHIVE_HEADER("2026-H2"));
} catch {
  duplicateApplyThrew = true;
}
assert(duplicateApplyThrew, "duplicate key: core apply rejects a formerly valid candidate even with unchanged boundaries and original text");

// The exclusion is file-wide, including pointers, multi-key entries and
// unresolved spans; identical originals are also ambiguous, never merged.
for (const [index, other] of [
  duplicateFirst,
  "### Other incident [MEM-610]\nSeparate heading-owned incident.",
  "## Another category\n\n- [MEM-610] Different category.",
  "- [MEM-610] → see semantic/lesson.md:2 — Existing pointer",
  "- [MEM-610] Incident also mentioning MEM-999.",
  "## Unresolved category\nUnowned prose.\n- [MEM-610] Unresolved bullet.",
].entries()) {
  const source = `# Mistakes\n\n${duplicateFirst}\n\n${other}\n`;
  const found = findMistakesTrimCandidates(source, GROUPED_DESTINATIONS);
  assert(!found.candidates.some((c) => c.key === "MEM-610") && found.structuralDiagnostics.some((d) => d.reason.includes("MEM-610")), `duplicate key: file-wide exclusion, case ${index + 1}`);
}
assert(findMistakesTrimCandidates(`Unparsed reference to MEM-610.\n\n${duplicateCategory}`, GROUPED_DESTINATIONS).candidates.length === 0, "duplicate key: unparsed content also blocks a key");
const datedDuplicate = duplicateCategory.replaceAll("MEM-610", DATED_B);
assert(findMistakesTrimCandidates(datedDuplicate, GROUPED_DESTINATIONS).candidates.length === 0, "duplicate key: dated IDs also excluded");
const repeatedInsideEntry = `## Single incident [MEM-610]\n${detail.repeat(10)}\n- Supporting detail about [MEM-610].\n\n> 📦 1 mistake archived — Keys: MEM-610\n`;
assert(findMistakesTrimCandidates(repeatedInsideEntry, GROUPED_DESTINATIONS).candidates.length === 1, "duplicate key: repeated citations within one owner and aggregate stub do not create duplicate entries");

// Real CLI regression: proposal writes nothing; explicit approval fails
// closed with both source and archive byte-identical, present or absent.
const overCapDuplicateCategory = duplicateCategory.replace(detail.repeat(12), detail.repeat(60));
const duplicateCliCases = [["under-cap", duplicateCategory], ["over-cap", overCapDuplicateCategory]]
  .flatMap(([size, source]) => [false, true].map((existingArchive) => ({ size, source, existingArchive })));
for (const { size, source, existingArchive } of duplicateCliCases) {
  withMistakeFixture(source, GROUPED_DESTINATIONS, (root, sourcePath) => {
    const now = new Date();
    const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth() < 6 ? "H1" : "H2"}`;
    const archivePath = path.join(root, "memory/episodic/archive", `mistakes-${bucket}.md`);
    const archiveBefore = Buffer.from("# Existing archive\n\nPreserve unrelated historical detail.\n");
    if (existingArchive) {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, archiveBefore);
    }
    const sourceBefore = fs.readFileSync(sourcePath);
    const unchanged = () => fs.readFileSync(sourcePath).equals(sourceBefore) && (existingArchive
      ? fs.readFileSync(archivePath).equals(archiveBefore)
      : !fs.existsSync(path.join(root, "memory/episodic")));
    const propose = runMistakeCli(root);
    assert(propose.status === 0 && propose.stdout.includes("candidates=0") && propose.stderr.includes("MEM-610") && propose.stderr.includes("unresolved"), `duplicate CLI (${size}, archive=${existingArchive}): proposal excludes key with diagnostic`);
    assert(unchanged(), `duplicate CLI (${size}, archive=${existingArchive}): proposal preserves source and archive bytes`);
    const apply = runMistakeCli(root, ["--apply", "--only", "MEM-610"]);
    assert(apply.status === 1 && apply.stderr.includes("no write performed"), `duplicate CLI (${size}, archive=${existingArchive}): explicit approval aborts`);
    assert(unchanged(), `duplicate CLI (${size}, archive=${existingArchive}): apply preserves both originals and archive bytes`);
  });
}
withMistakeFixture(uniqueCategory, GROUPED_DESTINATIONS, (root, sourcePath) => {
  const apply = runMistakeCli(root, ["--apply", "--only", "MEM-610,MEM-617"]);
  const archiveDir = path.join(root, "memory/episodic/archive");
  const archive = fs.existsSync(archiveDir) ? fs.readFileSync(path.join(archiveDir, fs.readdirSync(archiveDir)[0]), "utf8") : "";
  assert(apply.status === 0 && fs.readFileSync(sourcePath, "utf8") === uniqueApplied.mistakes && uniqueFound.candidates.every((c) => archive.includes(`\n${c.originalText}\n`)), "unique control CLI: both category bullets shortened with both originals archived");
});

console.log(`${passed} assertions passed, ${failed} failed`);
if (failed) process.exitCode = 1;
