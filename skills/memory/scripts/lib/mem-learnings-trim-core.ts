/**
 * Pure trim logic for memory/core/LEARNINGS.md entries whose content has
 * already been promoted into a deeper-tier narrative file (semantic/
 * episodic/procedural).
 *
 * Why a step exists (poller-brain#300, triaged from #293/#285): consolidate
 * Step 5c only archives a LEARNINGS.md entry when its `[MEM-NNN]` key is
 * OBSOLETE/REMOVED in MEM_REGISTRY.md, or when a resolved episodic
 * follow-up exists. On a mature brain, load-bearing lessons stay ACTIVE
 * forever, so that gate rarely fires — LEARNINGS.md grows monotonically
 * with no reachable reduction path (measured: tiketo-dev 43147B, 8.6x the
 * 5000B cap, 9 consecutive "no safe candidate" cycles).
 *
 * This module targets a DIFFERENT, narrower case than Step 5c: an entry
 * that started as a short lesson but later got a full incident writeup in
 * `semantic/`, `episodic/`, or `procedural/` — the short version and the
 * full version now say the same thing twice. Once a deeper file
 * demonstrably cites the entry's key, the entry can shrink to a pointer
 * without losing anything (the detail lives at the pointer target). This
 * mirrors mem-registry-trim-core.ts (poller-brain#244) exactly — same
 * citation-detection heuristic, imported from ./citation-detect.ts — applied
 * one tier up the promotion chain (LEARNINGS.md → semantic/episodic/
 * procedural, instead of MEM_REGISTRY.md → LEARNINGS.md/semantic/episodic/
 * procedural).
 *
 * ENTRY-LEVEL, NOT LINE-LEVEL (DevGuru catch, poller-brain#300 review round
 * 2): different brains use different LEARNINGS.md conventions — this brain
 * (vibe-keeper-brain) writes one bullet per lesson (`- **Title** — body.
 * (Source: ..., [MEM-N])`), but a brain following the "### Heading + Rule/
 * Why/How-to-apply bold-label paragraphs" convention documented in the
 * file's own footer spans MULTIPLE lines per entry, and uses `###` not `- `
 * as the entry marker. Round 1 of this module only recognized `- ` bullets and
 * rewrote a single matched LINE — on a heading-format brain that's a
 * silent, permanent no-op (0 candidates forever, indistinguishable from
 * "genuinely clean"), and on a multi-line bullet entry (a single entry
 * whose prose wraps and cites its key on more than one line, e.g. a
 * "(Source: ...)" tag on its own trailing line) it could rewrite the FIRST
 * cited line while leaving the rest of the paragraph behind as an orphan
 * under the new pointer.
 *
 * An "entry" here is generic across both observed conventions: any line
 * starting a NEW entry (`### ` heading, or top-level `- ` bullet) through
 * the line immediately before the next entry start (or EOF). Citation
 * counting and the already-a-pointer check both operate on the WHOLE entry
 * span, not a single line — a multi-key entry (its key(s) split across
 * several lines) is rejected as a whole, and a rewrite always replaces the
 * complete span, never leaving an orphaned remainder.
 *
 * Two deliberate scoping decisions, both conservative-by-construction:
 *
 * 1. **Destinations exclude `core/` entirely** (unlike mem-registry-trim,
 *    which includes it). LEARNINGS.md entries end with their own
 *    `(Source: ..., [MEM-NNN])` self-citation — if `core/LEARNINGS.md`
 *    itself were scanned as a destination, every single-key entry would
 *    spuriously "cite itself" as evidence of its own promotion, proposing
 *    nonsensical self-pointers. Restricting destinations to the tiers that
 *    are actually downstream of LEARNINGS.md in the promotion chain avoids
 *    the whole class. Enforced HERE (`findLearningsTrimCandidates` throws on
 *    a `core/`-prefixed destination), not just as a CLI `DEST_DIRS`
 *    convention — a caller who bypasses the CLI can't reopen the hazard
 *    (DevGuru catch, poller-brain#300 review round 1).
 *
 * 2. **Only single-key entries are eligible candidates**, same as the
 *    registry version's single-key-line evidence rule — but here it's
 *    applied across the WHOLE entry, not just one line. Most LEARNINGS.md
 *    entries already bundle multiple `[MEM-NNN]` keys from manual
 *    consolidation (`- **X** (konsoliduje [MEM-1][MEM-4]...) — ...`) — a
 *    multi-key entry's prose isn't attributable to any single key, so
 *    collapsing it to a one-key pointer would silently drop the other
 *    keys' content. Out of scope for this automated step; stays a manual
 *    consolidation judgment call (Step 5c already exists for that).
 *
 * Intentionally fs-free — pure string fixtures, unit-testable without a
 * real brain's memory/.
 */

import {
  type DestinationFile,
  firstCitations,
  extractHook,
  isReliableHook,
  distinctCitedKeysInLine,
  sortKeys,
} from "./citation-detect.js";

export type { DestinationFile };

/**
 * A key had a genuine single-key citation, but the extracted hook was too
 * short or fragment-shaped to trust as a description — excluded from
 * `candidates` rather than proposed with garbage content, since here the
 * hook is the ONLY content that survives a rewrite (DevGuru catch,
 * poller-brain#300 review round 3).
 */
export interface UnreliableHook {
  key: string;
  file: string;
  line: number;
  lineText: string;
  hook: string;
}

type EntryFormat = "bullet" | "heading";

/** A parsed entry span within LEARNINGS.md, 0-indexed line numbers. */
interface Entry {
  format: EntryFormat;
  /** First line of the entry (inclusive). */
  startLine: number;
  /**
   * Line immediately after the entry's last CONTENT line (exclusive) — the
   * span citation-scanning, the pointer/multi-key checks, and a rewrite all
   * operate on. Deliberately excludes trailing blank lines: those are the
   * visual separator before the NEXT entry, not part of this one, and a
   * rewrite must preserve them (a heading-format entry is followed by a
   * blank line before the next `### `; collapsing that blank line into the
   * rewrite would glue two entries together with no separator).
   */
  contentEndLine: number;
  /** Line immediately after the entry's last line INCLUDING trailing blanks (exclusive) — next entry's startLine, or EOF. Used only to know how many separator lines to copy verbatim after a rewrite. */
  endLine: number;
}

const HEADING_START_RE = /^###\s+/;
const BULLET_START_RE = /^-\s+/;

/** Matches an already-trimmed pointer bullet entry. */
export const POINTER_BULLET_RE = /^-\s*\[MEM-\d+\]\s*→\s*see\s+\S/;

/** Matches an already-trimmed pointer heading entry. */
export const POINTER_HEADING_RE = /^###\s*\[MEM-\d+\]\s*→\s*see\s+\S/;

function entryFormatOf(line: string): EntryFormat | null {
  if (HEADING_START_RE.test(line)) return "heading";
  if (BULLET_START_RE.test(line)) return "bullet";
  return null;
}

/** Split `text` into entry spans. Lines before the first entry start (title, blank lines) belong to no entry. */
function parseEntries(text: string): { entries: Entry[]; lines: string[] } {
  const lines = text.split("\n");
  const starts: { idx: number; format: EntryFormat }[] = [];
  lines.forEach((line, idx) => {
    const format = entryFormatOf(line);
    if (format) starts.push({ idx, format });
  });
  const entries: Entry[] = starts.map((s, i) => {
    const endLine = i + 1 < starts.length ? starts[i + 1].idx : lines.length;
    let contentEndLine = endLine;
    while (contentEndLine > s.idx + 1 && lines[contentEndLine - 1].trim() === "") contentEndLine--;
    return { format: s.format, startLine: s.idx, contentEndLine, endLine };
  });
  return { entries, lines };
}

function entryText(lines: string[], entry: Entry): string {
  return lines.slice(entry.startLine, entry.contentEndLine).join("\n");
}

function isPointerEntry(text: string): boolean {
  return POINTER_BULLET_RE.test(text) || POINTER_HEADING_RE.test(text);
}

function entryCitedKeys(lines: string[], entry: Entry): string[] {
  const keys = new Set<string>();
  for (let i = entry.startLine; i < entry.contentEndLine; i++) {
    for (const k of distinctCitedKeysInLine(lines[i])) keys.add(k);
  }
  return [...keys];
}

export interface LearningsTrimCandidate {
  key: string;
  format: EntryFormat;
  /** 1-indexed first line of the entry within LEARNINGS.md. */
  entryStartLine: number;
  /** 1-indexed LAST line of the entry (inclusive) within LEARNINGS.md. */
  entryEndLine: number;
  file: string;
  /** 1-indexed line number within the destination file. */
  line: number;
  /** Full citing line, verbatim — a reviewer should never have to dig through the destination file to judge this. */
  lineText: string;
  /** Deterministic short hook derived from `lineText`, used in the proposed pointer. */
  hook: string;
}

export interface FindLearningsCandidatesResult {
  candidates: LearningsTrimCandidate[];
  /** Entries seen (any key count, any status). */
  totalEntries: number;
  /** Entries citing 2+ distinct MEM-N keys across their span — never eligible. */
  multiKeyEntries: number;
  /** Entries already a pointer (idempotence gate) — not re-proposed. */
  alreadyPointer: number;
  /** Destination lines skipped as index/pointer-shaped, not narrative evidence — surfaced so coverage loss is never silent. */
  indexRejections: import("./citation-detect.js").IndexRejection[];
  /** Keys with a genuine citation but an unreliable extracted hook — excluded from `candidates`, surfaced so coverage loss is never silent. */
  unreliableHooks: UnreliableHook[];
}

/**
 * Find LEARNINGS.md entries that are NOT yet a pointer, cite EXACTLY ONE
 * MEM-N key across their whole span, and have a genuine single-key citation
 * somewhere in `destinations` (expected: semantic/episodic/procedural files
 * — never pass core/LEARNINGS.md itself, see module doc). Read-only — never
 * mutates `learnings` and never decides what gets written.
 */
export function findLearningsTrimCandidates(
  learnings: string,
  destinations: DestinationFile[]
): FindLearningsCandidatesResult {
  const badCoreDest = destinations.find((d) => d.file === "core" || d.file.startsWith("core/"));
  if (badCoreDest) {
    throw new Error(
      `destinations must not include core/ (got "${badCoreDest.file}") — LEARNINGS.md entries self-cite ` +
        `their own key in the trailing "(Source: ..., [MEM-N])", so scanning core/ as a destination would ` +
        `spuriously self-cite every single-key entry. See module doc.`
    );
  }

  const { citations, indexRejections } = firstCitations(destinations);
  const { entries, lines } = parseEntries(learnings);
  const candidates: LearningsTrimCandidate[] = [];
  const unreliableHooks: UnreliableHook[] = [];
  let alreadyPointer = 0;
  let multiKeyEntries = 0;

  for (const entry of entries) {
    const text = entryText(lines, entry);

    if (isPointerEntry(text)) {
      alreadyPointer++;
      continue;
    }

    const keys = entryCitedKeys(lines, entry);
    if (keys.length !== 1) {
      if (keys.length > 1) multiKeyEntries++;
      continue; // no key, or multi-key entry (possibly split across lines) — not eligible
    }

    const key = keys[0];
    const citation = citations.get(key);
    if (!citation) continue; // no genuine single-key citation found — not (yet) promoted anywhere

    const hook = extractHook(citation);
    if (hook === null || !isReliableHook(hook)) {
      unreliableHooks.push({
        key,
        file: citation.file,
        line: citation.line,
        lineText: citation.lineText,
        hook: hook ?? "(no governing heading)",
      });
      continue;
    }

    candidates.push({
      key,
      format: entry.format,
      entryStartLine: entry.startLine + 1,
      entryEndLine: entry.contentEndLine, // 0-indexed exclusive content end == 1-indexed inclusive last CONTENT line (excludes trailing blank separator)
      file: citation.file,
      line: citation.line,
      lineText: citation.lineText,
      hook,
    });
  }

  return {
    candidates: sortCandidates(candidates),
    totalEntries: entries.length,
    multiKeyEntries,
    alreadyPointer,
    indexRejections,
    unreliableHooks,
  };
}

function sortCandidates(candidates: LearningsTrimCandidate[]): LearningsTrimCandidate[] {
  return [...candidates].sort(
    (a, b) => parseInt(a.key.slice(4), 10) - parseInt(b.key.slice(4), 10)
  );
}

export interface LearningsTrimStats {
  totalEntries: number;
  multiKeyEntries: number;
  alreadyPointer: number;
  /** Entries not yet a pointer, that had a candidate available (whether or not it was applied). */
  candidateEntries: number;
  /** Entries actually rewritten this call. */
  trimmedEntries: number;
  trimmedKeys: string[];
  bytesBefore: number;
  bytesAfter: number;
  /** Distinct MEM-N keys cited across all entries, before/after — a real invariant: trimming an entry to a pointer keeps citing its own key, so this must never change. */
  distinctKeysBefore: number;
  distinctKeysAfter: number;
}

export interface LearningsTrimResult {
  learnings: string;
  stats: LearningsTrimStats;
}

/** Trailing `(Source: ..., [MEM-N])` provenance anywhere in an entry — captures everything except the redundant `[MEM-N]` tag, which the pointer already carries as its own prefix. Searches the WHOLE entry (the tag may be on its own trailing line in a multi-line entry), takes the LAST match. */
const SOURCE_RE = /\(Source:\s*([^)]*?)(?:,\s*\[MEM-\d+\])?\)/g;

function extractSource(entryText: string): string | null {
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  SOURCE_RE.lastIndex = 0;
  while ((m = SOURCE_RE.exec(entryText))) last = m;
  if (!last) return null;
  const source = last[1].trim().replace(/,\s*$/, "");
  return source || null;
}

function countDistinctEntryKeys(learnings: string): number {
  const { entries, lines } = parseEntries(learnings);
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const k of entryCitedKeys(lines, entry)) keys.add(k);
  }
  return keys.size;
}

/**
 * Rewrite LEARNINGS.md entries for exactly the given `candidates` — an
 * explicit, caller-approved list (typically a subset, or all, of what
 * `findLearningsTrimCandidates` returned). An entry is replaced WHOLESALE
 * (its entire span, not a single line) with a single pointer line whose
 * marker matches the entry's own format — `- [MEM-NNN] → see <file>:<line>
 * — <hook>` for a bullet entry, `### [MEM-NNN] → see <file>:<line> —
 * <hook>` for a heading entry — plus the original `(Source: ...)`
 * provenance, if any was found anywhere in the entry. Entries whose key
 * isn't in `candidates` are left completely untouched, including entries
 * that WERE candidates but weren't approved.
 *
 * Defensive guard: `candidates` is keyed by entry start line NUMBER, not by
 * a value parsed fresh off the span being rewritten — unlike the registry
 * version's `applyTrimCandidates`, where the row key is re-parsed from the
 * very line being written, so a mismatch is structurally impossible. Here a
 * stale `candidates` list (computed against different LEARNINGS.md content,
 * e.g. after an intervening edit shifted line numbers) could otherwise
 * silently overwrite the WRONG entry. So we re-verify the entry actually
 * cites EXACTLY `candidate.key` before writing, and throw rather than
 * corrupt.
 */
export function applyLearningsTrimCandidates(
  learnings: string,
  candidates: LearningsTrimCandidate[]
): LearningsTrimResult {
  const { entries, lines } = parseEntries(learnings);
  const byStartLine = new Map(candidates.map((c) => [c.entryStartLine, c]));

  const trimmedKeys: string[] = [];
  let alreadyPointer = 0;
  let candidateEntries = 0;

  const outLines: string[] = [];
  let cursor = 0;

  for (const entry of entries) {
    // Copy any non-entry lines (title, blank lines) preceding this entry verbatim.
    for (let i = cursor; i < entry.startLine; i++) outLines.push(lines[i]);

    const text = entryText(lines, entry);
    const startLine1 = entry.startLine + 1;

    if (isPointerEntry(text)) {
      alreadyPointer++;
      for (let i = entry.startLine; i < entry.endLine; i++) outLines.push(lines[i]);
      cursor = entry.endLine;
      continue;
    }
    candidateEntries++;

    const candidate = byStartLine.get(startLine1);
    if (!candidate) {
      for (let i = entry.startLine; i < entry.endLine; i++) outLines.push(lines[i]);
      cursor = entry.endLine;
      continue; // no approved candidate for this entry — keep full narrative
    }

    const keysInEntry = entryCitedKeys(lines, entry);
    if (keysInEntry.length !== 1 || keysInEntry[0] !== candidate.key) {
      throw new Error(
        `Candidate for ${candidate.key} points at LEARNINGS.md entry starting at line ${startLine1}, but that ` +
          `entry cites [${keysInEntry.join(", ") || "no key"}] — stale candidate list (content changed since ` +
          `it was computed?). Aborting, no write performed.`
      );
    }

    trimmedKeys.push(candidate.key);
    const source = extractSource(text);
    const marker = candidate.format === "heading" ? "###" : "-";
    const pointer = `${marker} [${candidate.key}] → see ${candidate.file}:${candidate.line} — ${candidate.hook}`;
    outLines.push(source ? `${pointer} (Source: ${source})` : pointer);
    cursor = entry.endLine;
  }
  // Trailing lines after the last entry.
  for (let i = cursor; i < lines.length; i++) outLines.push(lines[i]);

  const newLearnings = outLines.join("\n");

  return {
    learnings: newLearnings,
    stats: {
      totalEntries: entries.length,
      multiKeyEntries: 0, // not tracked here — see findLearningsTrimCandidates for the propose-time count
      alreadyPointer,
      candidateEntries,
      trimmedEntries: trimmedKeys.length,
      trimmedKeys: sortKeys(trimmedKeys),
      bytesBefore: Buffer.byteLength(learnings),
      bytesAfter: Buffer.byteLength(newLearnings),
      distinctKeysBefore: countDistinctEntryKeys(learnings),
      distinctKeysAfter: countDistinctEntryKeys(newLearnings),
    },
  };
}

export interface OnlySelector {
  key: string;
  /** null = bare key (no `@line` suffix). */
  line: number | null;
}

/**
 * Pure parser for a `--only` flag value (comma-separated bare keys and/or
 * `MEM-N@<entryStartLine>` span selectors) — no argv/process.exit, throws on
 * a malformed token so it's unit-testable without mocking either
 * (poller-brain#334 review round 1, nonblocking 1: the CLI's original
 * inline version silently dropped extra "@"-segments — `tok.split("@")`
 * destructuring only reads the first two array elements, so
 * `"MEM-25@3@9"` parsed as `line=3` with no error at all — and `Number()`
 * accepts non-decimal forms like `"0x3"`). Requires exactly one "@" and a
 * plain decimal digit run for the line part.
 */
export function parseOnlySelectors(raw: string): OnlySelector[] {
  return raw
    .split(",")
    .map((tok) => tok.trim())
    .filter(Boolean)
    .map((tok) => {
      const parts = tok.split("@");
      if (parts.length > 2) {
        throw new Error(`--only span selector "${tok}" has more than one "@" — expected MEM-N@<entryStartLine>`);
      }
      const [key, lineStr] = parts;
      if (lineStr === undefined) return { key, line: null };
      if (!/^\d+$/.test(lineStr)) {
        throw new Error(
          `--only span selector "${tok}" has an invalid line number — expected MEM-N@<entryStartLine> (digits only)`
        );
      }
      const line = Number(lineStr);
      if (line <= 0) {
        throw new Error(`--only span selector "${tok}" has an invalid line number — expected MEM-N@<entryStartLine>`);
      }
      return { key, line };
    });
}

/** Groups candidates by key — used both to print `@line` hints only where actually needed, and to resolve `--only` selectors. */
export function groupCandidatesByKey(candidates: LearningsTrimCandidate[]): Map<string, LearningsTrimCandidate[]> {
  const byKey = new Map<string, LearningsTrimCandidate[]>();
  for (const c of candidates) {
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key)!.push(c);
  }
  return byKey;
}

/**
 * Keys with exactly ONE candidate — the only ones safe to list in the
 * headline copy-paste `--apply --only ...` command (poller-brain#334 review
 * round 1, blocking 2): the CLI's original headline pre-expanded to EVERY
 * candidate, including all span selectors for an ambiguous key, so
 * copy-pasting it verbatim applied both the genuine candidate and a bogus
 * cross-ref one — overwriting the cross-ref bullet with a duplicate
 * pointer, silently, since the count-verify checks don't change (two
 * pointers for the same key don't change the distinct-key count). Ambiguous
 * keys are deliberately excluded here; a reviewer must pick a span selector
 * for each by hand.
 */
export function unambiguousHeadlineKeys(candidates: LearningsTrimCandidate[]): string[] {
  const byKey = groupCandidatesByKey(candidates);
  return candidates.filter((c) => byKey.get(c.key)!.length === 1).map((c) => c.key);
}

/**
 * Convenience wrapper: find AND apply every candidate found by a blind
 * scan, with no review step in between. Kept for tests and for callers
 * that have already decided (out of band) that full trust is appropriate.
 * The CLI does NOT use this for its default backfill path — see
 * mem-learnings-trim.ts for why (propose-only by default).
 */
export function trimPromotedLearnings(
  learnings: string,
  destinations: DestinationFile[]
): LearningsTrimResult {
  const { candidates } = findLearningsTrimCandidates(learnings, destinations);
  return applyLearningsTrimCandidates(learnings, candidates);
}

/**
 * Machine count-verify. Throws with an actionable message on any invariant
 * break so the CLI / consolidate step fails loud rather than silently
 * writing a corrupted LEARNINGS.md. Returns the list of assertions that
 * passed.
 */
export function verifyLearningsTrimStats(stats: LearningsTrimStats): string[] {
  const checks: string[] = [];

  if (stats.bytesAfter > stats.bytesBefore) {
    throw new Error(
      `Trim increased LEARNINGS.md size (${stats.bytesBefore} → ${stats.bytesAfter} bytes) — ` +
        `aborting, no write performed.`
    );
  }
  checks.push(`size: ${stats.bytesBefore} → ${stats.bytesAfter} bytes (no growth) ✅`);

  if (stats.trimmedEntries !== stats.trimmedKeys.length) {
    throw new Error(
      `Count mismatch: trimmedEntries=${stats.trimmedEntries} but trimmedKeys.length=${stats.trimmedKeys.length}.`
    );
  }
  checks.push(`count: trimmedEntries(${stats.trimmedEntries}) == trimmedKeys.length ✅`);

  if (stats.distinctKeysBefore !== stats.distinctKeysAfter) {
    throw new Error(
      `Trim changed the set of distinct MEM-N keys cited in LEARNINGS.md (${stats.distinctKeysBefore} → ` +
        `${stats.distinctKeysAfter}) — a pointer must keep citing its own key. Aborting, no write performed.`
    );
  }
  checks.push(`keys: ${stats.distinctKeysBefore} distinct MEM-N keys preserved ✅`);

  return checks;
}
