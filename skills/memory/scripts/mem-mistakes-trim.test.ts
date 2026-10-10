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
 * Exits non-zero on the first failed assertion.
 */

import {
  findMistakesTrimCandidates,
  applyMistakesTrimCandidates,
  verifyMistakesTrimStats,
  DEFAULT_ARCHIVE_HEADER,
  type DestinationFile,
  type MistakesTrimCandidate,
} from "./lib/mem-mistakes-trim-core.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// ===========================================================================
// Suite 1: `##`-heading format (documented convention — skills/memory/
// skill.md "MISTAKES.md Entry Format"). Reproduces the real corruption shape
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
      "### Communication style",
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
  hash2Applied.mistakes.includes("## [MEM-902] → see core/LEARNINGS.md:3 — Communication style"),
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
      "## Measure the right artifact",
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
    "### [MEM-950] → see semantic/measurement-discipline.md:3 — Measure the right artifact"
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
      "### CI green discipline",
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
assert(bulletMem154.file === "core/LEARNINGS.md" && bulletMem154.line === 3, "bullet: candidate points at core/LEARNINGS.md:3");
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
    "- [MEM-154] → see core/LEARNINGS.md:3 — CI green discipline (Source: Jakub, 2026-06-01)"
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
  bulletApplied.archive.includes("Archived 2026-08-20 — superseded by core/LEARNINGS.md:3 [MEM-154]"),
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

console.log(`✅ all ${passed} assertions passed`);
