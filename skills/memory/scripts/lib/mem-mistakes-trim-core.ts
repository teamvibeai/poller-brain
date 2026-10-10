/**
 * Pure trim + archival logic for memory/core/MISTAKES.md entries whose
 * lesson has already been promoted into core/LEARNINGS.md, semantic/, or
 * procedural/ — poller-brain#328.
 *
 * Why a step exists: MISTAKES.md has no reduction path at all today. The
 * existing consolidate Step 5 ("Promote Mistakes") is supposed to cover
 * this via a `status: new` → `status: promoted` lifecycle, but nothing in
 * the actual write path (mem-write.ts, consolidate Step 1b.4) ever emits a
 * `status:` field on a MISTAKES.md entry — so Step 5's trigger cannot fire
 * on ANY brain, not just brains that "haven't adopted the convention"
 * (poller-brain#328 issue text, confirmed against mem-write.ts and Step
 * 1b.4 before filing this PR). This module follows Step 5d/9e's
 * content-based detection instead: never keyed off `status:`.
 *
 * Two things happen on a trim, not one, because MISTAKES.md entries often
 * carry incident-specific detail (exact date, exact failure scenario) that
 * a condensed LEARNINGS.md/semantic/procedural restatement drops. Simply
 * pointer-shrinking in place (Step 5d's approach) would silently lose that
 * detail forever:
 *   1. The full original entry is archived VERBATIM to
 *      `memory/episodic/archive/mistakes-YYYY-Hn.md` (half-year bucket,
 *      same convention as Step 5c's learnings archive) — nothing is
 *      deleted, only relocated, per the issue's explicit "reduction paths
 *      should relocate resolved patterns, not delete them" nuance.
 *   2. The entry in MISTAKES.md is replaced with a short pointer citing the
 *      destination that proves promotion (where the active, going-forward
 *      lesson lives) — SAME format as Step 5d, deliberately with no
 *      per-entry archive-location annotation. An earlier version of this
 *      module appended a per-pointer "(history: episodic/archive/
 *      mistakes-YYYY-Hn.md)" note; on a short original entry that made the
 *      pointer LONGER than the entry it replaced, defeating the point of a
 *      size-reduction step (caught by this file's own test fixtures before
 *      review). The archive location is instead surfaced ONCE, in a single
 *      aggregate stub line (see `buildStub`) — the same amortized-cost
 *      pattern `mem-registry-archive-core.ts` already uses for N archived
 *      REMOVED rows. Per-entry, the archive is still fully discoverable:
 *      every archived entry's provenance header embeds its own `[MEM-N]`
 *      tag, so `grep -r "MEM-N" memory/` finds it directly — "grep-
 *      searchable, out of hot path" per the issue text, without paying a
 *      per-entry byte cost for it.
 *
 * Detection reuses citation-detect.ts unchanged — same heuristic, same
 * three-adversarial-round hardening (poller-brain#244/#300) against
 * index-shaped lines, multi-key ambiguity, and unreliable hooks. Read as
 * *candidates for human review*, never as auto-write evidence — same
 * propose/apply split as mem-registry-trim.ts and mem-learnings-trim.ts.
 *
 * Entry-parsing (bullet `- ` / heading `## `/`### `) is intentionally
 * duplicated from mem-learnings-trim-core.ts rather than factored into a
 * shared module — the two files' entry models are similar but not identical
 * (different destination scoping, different apply-time side effect), and
 * keeping this file self-contained avoids widening the review surface of
 * the already-shipped, already-tested LEARNINGS trim path.
 *
 * Heading level is `##` OR `###` — the documented MISTAKES.md convention
 * (`skills/memory/skill.md` "MISTAKES.md Entry Format") is `## YYYY-MM-DD —
 * ...`, but at least one live brain uses `###`, so both are recognized and
 * a matched entry's OWN marker is preserved on its pointer rewrite (never
 * forced to one level). A bullet (`- `) only starts a NEW entry when it is
 * NOT inside an already-open heading entry — DevGuru poller-brain#328 round
 * 1 caught the real-world failure mode of the naive version (bullet-anywhere
 * = new entry): on a real 17,977 B `##`-format MISTAKES.md, 0 of 24 real
 * entries were recognized and a `- ` sub-bullet from the MIDDLE of one
 * entry's body was sliced out, archived as if it were its own mistake, and
 * left the file 100 B LARGER while the grow-guard still printed a false
 * "no growth ✅" (see `verifyMistakesTrimStats` growth-invariant note). A
 * heading entry, once opened, stays open (governs all bullets under it)
 * until the next heading or end of file — matching how these files are
 * actually written (a heading title, prose, then supporting `- ` detail
 * bullets, all one entry).
 *
 * Intentionally fs-free — pure string fixtures, unit-testable without a
 * real brain's memory/. The CLI resolves the current half-year bucket name
 * from a real clock and passes it in.
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

export interface UnreliableHook {
  key: string;
  file: string;
  line: number;
  lineText: string;
  hook: string;
}

type EntryFormat = "bullet" | "heading";

interface Entry {
  format: EntryFormat;
  /** Literal prefix this entry actually used: "##", "###", or "-". Preserved verbatim on trim. */
  marker: string;
  startLine: number;
  contentEndLine: number;
  endLine: number;
}

const HEADING_START_RE = /^(#{2,3})\s+/;
const BULLET_START_RE = /^-\s+/;

/** Matches an already-trimmed pointer entry — same shape as Step 5d's LEARNINGS.md pointer. */
const POINTER_BULLET_RE = /^-\s*\[MEM-\d+\]\s*→\s*see\s+\S/;
const POINTER_HEADING_RE = /^#{2,3}\s*\[MEM-\d+\]\s*→\s*see\s+\S/;
/** Extracts the key from a matched pointer line (either marker, either heading level). */
const POINTER_KEY_RE = /^(?:-|#{2,3})\s*\[(MEM-\d+)\]\s*→\s*see\s/;

function entryStartOf(line: string): { format: EntryFormat; marker: string } | null {
  const heading = HEADING_START_RE.exec(line);
  if (heading) return { format: "heading", marker: heading[1] };
  if (BULLET_START_RE.test(line)) return { format: "bullet", marker: "-" };
  return null;
}

/**
 * Split `text` into top-level entries. A heading (`##`/`###`) always starts a
 * new entry. A bullet (`- `) starts a new entry ONLY when no heading entry is
 * currently open — once any heading has been seen, every subsequent `- `
 * line is that heading entry's body content, never a sibling entry (see
 * module doc for the real-data failure this prevents).
 *
 * The trailing aggregate stub line (`STUB_RE`, see `buildStub`) is never
 * folded into the last entry's citable content — it's a file-level trailer
 * that lists every archived key as bare text, so without this exclusion the
 * last entry in the file would pick up every other entry's archived key as
 * its own citation and spuriously read as multi-key on re-scan, blocking a
 * legitimately single-key last entry from ever being proposed again.
 */
function parseEntries(text: string): { entries: Entry[]; lines: string[] } {
  const lines = text.split("\n");
  const starts: { idx: number; format: EntryFormat; marker: string }[] = [];
  let headingOpen = false;
  lines.forEach((line, idx) => {
    const start = entryStartOf(line);
    if (!start) return;
    if (start.format === "heading") {
      starts.push({ idx, ...start });
      headingOpen = true;
    } else if (!headingOpen) {
      starts.push({ idx, ...start });
    }
    // else: a bullet under an open heading entry — body content, not a new entry.
  });
  const entries: Entry[] = starts.map((s, i) => {
    const endLine = i + 1 < starts.length ? starts[i + 1].idx : lines.length;
    let contentEndLine = endLine;
    while (
      contentEndLine > s.idx + 1 &&
      (lines[contentEndLine - 1].trim() === "" || STUB_RE.test(lines[contentEndLine - 1]))
    ) {
      contentEndLine--;
    }
    return { format: s.format, marker: s.marker, startLine: s.idx, contentEndLine, endLine };
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

const SOURCE_RE = /\(Source:\s*([^)]*?)(?:,\s*\[MEM-\d+\])?\)/g;

function extractSource(text: string): string | null {
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  SOURCE_RE.lastIndex = 0;
  while ((m = SOURCE_RE.exec(text))) last = m;
  if (!last) return null;
  const source = last[1].trim().replace(/,\s*$/, "");
  return source || null;
}

export interface MistakesTrimCandidate {
  key: string;
  format: EntryFormat;
  /** Literal prefix this entry actually used ("##", "###", or "-") — preserved verbatim on the pointer rewrite. */
  marker: string;
  /** 1-indexed first line of the entry within MISTAKES.md. */
  entryStartLine: number;
  /** 1-indexed LAST content line of the entry (inclusive) within MISTAKES.md. */
  entryEndLine: number;
  /** Destination proving promotion (where the active, going-forward lesson lives). */
  file: string;
  line: number;
  lineText: string;
  hook: string;
  /** The verbatim original entry text, captured at find-time so apply doesn't need to re-derive it. */
  originalText: string;
}

export interface FindMistakesCandidatesResult {
  candidates: MistakesTrimCandidate[];
  totalEntries: number;
  multiKeyEntries: number;
  alreadyPointer: number;
  indexRejections: import("./citation-detect.js").IndexRejection[];
  unreliableHooks: UnreliableHook[];
  /**
   * Fraction (0..1) of `mistakes`' bytes covered by a recognized entry span.
   * A well-formed file's entries cover nearly all of it; a value near 0 on a
   * file that has MEM- keys means the entry markers weren't recognized (see
   * module doc) — callers should treat that as a parse failure, not a clean
   * "no candidates" result, even when `totalEntries > 0` (misparsed
   * sub-bullets still count as "entries").
   */
  coverageRatio: number;
}

/**
 * Find MISTAKES.md entries that are NOT yet a pointer, cite EXACTLY ONE
 * MEM-N key across their whole span, and have a genuine single-key citation
 * in `destinations` (expected: core/LEARNINGS.md, semantic/, procedural/ —
 * never pass core/MISTAKES.md itself, see module doc). Read-only — never
 * mutates `mistakes` and never decides what gets written.
 */
export function findMistakesTrimCandidates(
  mistakes: string,
  destinations: DestinationFile[]
): FindMistakesCandidatesResult {
  const badSelfDest = destinations.find((d) => d.file === "core/MISTAKES.md");
  if (badSelfDest) {
    throw new Error(
      `destinations must not include core/MISTAKES.md — it would spuriously self-cite every single-key ` +
        `entry against its own (Source: ..., [MEM-N]) tag. core/LEARNINGS.md IS a valid destination here ` +
        `(unlike mem-learnings-trim-core.ts, which excludes all of core/). See module doc.`
    );
  }

  const { citations, indexRejections } = firstCitations(destinations);
  const { entries, lines } = parseEntries(mistakes);
  const candidates: MistakesTrimCandidate[] = [];
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
      continue;
    }

    const key = keys[0];
    const citation = citations.get(key);
    if (!citation) continue;

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
      marker: entry.marker,
      entryStartLine: entry.startLine + 1,
      entryEndLine: entry.contentEndLine,
      file: citation.file,
      line: citation.line,
      lineText: citation.lineText,
      hook,
      originalText: text,
    });
  }

  const totalBytes = Buffer.byteLength(mistakes);
  const coveredBytes = entries.reduce((sum, e) => sum + Buffer.byteLength(entryText(lines, e)), 0);
  const coverageRatio = totalBytes === 0 ? 1 : coveredBytes / totalBytes;

  return {
    candidates: sortCandidates(candidates),
    totalEntries: entries.length,
    multiKeyEntries,
    alreadyPointer,
    indexRejections,
    unreliableHooks,
    coverageRatio,
  };
}

function sortCandidates(candidates: MistakesTrimCandidate[]): MistakesTrimCandidate[] {
  return [...candidates].sort((a, b) => parseInt(a.key.slice(4), 10) - parseInt(b.key.slice(4), 10));
}

export interface MistakesTrimStats {
  totalEntries: number;
  alreadyPointer: number;
  candidateEntries: number;
  trimmedEntries: number;
  trimmedKeys: string[];
  mistakesBytesBefore: number;
  mistakesBytesAfter: number;
  /** Byte size of the aggregate stub line alone (0 if none) — see `verifyMistakesTrimStats`. */
  stubBytesBefore: number;
  stubBytesAfter: number;
  archiveBytesBefore: number;
  archiveBytesAfter: number;
  distinctKeysBefore: number;
  distinctKeysAfter: number;
  /** Keys whose original text is now present in the archive (round-trip check). */
  archivedKeys: string[];
}

export interface MistakesTrimResult {
  mistakes: string;
  archive: string;
  stats: MistakesTrimStats;
}

function countDistinctEntryKeys(mistakes: string): number {
  const { entries, lines } = parseEntries(mistakes);
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const k of entryCitedKeys(lines, entry)) keys.add(k);
  }
  return keys.size;
}

export const DEFAULT_ARCHIVE_HEADER = (bucket: string): string =>
  `# Mistakes Archive — ${bucket}

Resolved \`core/MISTAKES.md\` entries relocated here once their lesson was
demonstrably promoted into \`core/LEARNINGS.md\`, \`semantic/\`, or
\`procedural/\`. Appended by \`skills/memory/scripts/mem-mistakes-trim.ts\`
during consolidation — do not hand-edit. Full original wording is preserved
verbatim for audit/history; the live file keeps only a pointer.
`;

/** Matches an archived entry's provenance header line, used to detect a duplicate archival on re-run. */
function archiveHasKey(archive: string, key: string): boolean {
  const re = new RegExp(`^>\\s*Archived\\s.*\\[${key}\\]`, "m");
  return re.test(archive);
}

/** Matches the aggregate archive-pointer stub, so it can be stripped and regenerated (never appended twice). */
export const STUB_RE = /^>\s*📦\s*\d+\s*mistake/;

/** Byte size of the stub line in `content`, 0 if absent — used to separate stub overhead from entry-content size in the growth invariant (see `verifyMistakesTrimStats`). */
function stubBytesIn(content: string): number {
  const stubLine = content.split("\n").find((l) => STUB_RE.test(l));
  return stubLine ? Buffer.byteLength(stubLine) + 1 : 0;
}

/**
 * Build (or omit) the single aggregate stub line pointing at wherever
 * archived mistakes now live — amortized-cost design, see module doc: one
 * line regardless of how many keys have been archived, instead of a
 * per-entry annotation. Takes ONLY keys verifiably present in `archive`
 * (checked via `archiveHasKey`) — NOT every `[MEM-N]` that happens to be in
 * pointer format. A pre-existing/hand-written pointer whose key this script
 * never archived is left alone as a valid pointer, but is not claimed as
 * "full original text in mistakes-*.md" — DevGuru poller-brain#328 round 1:
 * an earlier version derived the count from pointer-shape alone and its own
 * test fixture proved the false claim (a pre-existing `[MEM-9]` pointer,
 * never archived by this script, was announced as archived — `grep` for it
 * in the archive would find nothing).
 */
function buildStub(archivedPointerKeys: string[]): string | null {
  if (archivedPointerKeys.length === 0) return null;
  const keys = sortKeys(archivedPointerKeys);
  return (
    `> 📦 ${keys.length} mistake${keys.length === 1 ? "" : "s"} archived — full original text in ` +
    `\`memory/episodic/archive/mistakes-*.md\` (grep for the key) — Keys: ${keys.join(", ")}`
  );
}

/**
 * Rewrite MISTAKES.md entries for exactly the given `candidates`, and
 * relocate each trimmed entry's full original text into `archive`
 * (creating it with `archiveHeader` if empty). An entry is replaced
 * WHOLESALE with a pointer line in the SAME format as Step 5d (destination
 * only — no per-entry archive annotation, see module doc). Entries not in
 * `candidates` are left completely untouched. After rewriting, the single
 * aggregate archive-pointer stub (see `buildStub`) is regenerated from
 * scratch at the end of the file.
 *
 * `archiveDate` (e.g. "2026-08-20") is supplied by the caller — this
 * module does no clock/fs access of its own.
 *
 * Idempotent per key: a key already present in `archive` (by its archival
 * provenance header) is not re-appended, only the pointer rewrite in
 * MISTAKES.md is (re-)applied.
 */
export function applyMistakesTrimCandidates(
  mistakes: string,
  archive: string,
  candidates: MistakesTrimCandidate[],
  archiveDate: string,
  archiveHeader: string
): MistakesTrimResult {
  const { entries, lines } = parseEntries(mistakes);
  const byStartLine = new Map(candidates.map((c) => [c.entryStartLine, c]));

  const trimmedKeys: string[] = [];
  const archivedKeys: string[] = [];
  let alreadyPointer = 0;
  let candidateEntries = 0;

  const outLines: string[] = [];
  let cursor = 0;
  let newArchive = archive.trim().length ? archive : archiveHeader;

  for (const entry of entries) {
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
      continue;
    }

    const keysInEntry = entryCitedKeys(lines, entry);
    if (keysInEntry.length !== 1 || keysInEntry[0] !== candidate.key) {
      throw new Error(
        `Candidate for ${candidate.key} points at MISTAKES.md entry starting at line ${startLine1}, but that ` +
          `entry cites [${keysInEntry.join(", ") || "no key"}] — stale candidate list. Aborting, no write performed.`
      );
    }

    trimmedKeys.push(candidate.key);

    if (!archiveHasKey(newArchive, candidate.key)) {
      const archiveEntry = `> Archived ${archiveDate} — superseded by ${candidate.file}:${candidate.line} [${candidate.key}]\n${candidate.originalText}\n`;
      newArchive = newArchive.replace(/\n*$/, "\n") + "\n" + archiveEntry;
      archivedKeys.push(candidate.key);
    }

    const source = extractSource(text);
    const marker = candidate.marker;
    const pointer = source
      ? `${marker} [${candidate.key}] → see ${candidate.file}:${candidate.line} — ${candidate.hook} (Source: ${source})`
      : `${marker} [${candidate.key}] → see ${candidate.file}:${candidate.line} — ${candidate.hook}`;
    outLines.push(pointer);
    cursor = entry.endLine;
  }
  for (let i = cursor; i < lines.length; i++) outLines.push(lines[i]);

  // Regenerate the aggregate stub from scratch: strip any prior stub
  // line(s), then re-derive from the pointer keys actually present in the
  // rewritten body (idempotent — never stacks, always matches reality).
  const bodyLines = outLines.filter((l) => !STUB_RE.test(l));
  const archivedPointerKeys: string[] = [];
  for (const l of bodyLines) {
    const m = POINTER_KEY_RE.exec(l);
    if (m && archiveHasKey(newArchive, m[1])) archivedPointerKeys.push(m[1]);
  }
  const stub = buildStub(archivedPointerKeys);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
  const finalLines = stub === null ? bodyLines : [...bodyLines, "", stub];

  const newMistakes = finalLines.join("\n") + "\n";

  return {
    mistakes: newMistakes,
    archive: newArchive,
    stats: {
      totalEntries: entries.length,
      alreadyPointer,
      candidateEntries,
      trimmedEntries: trimmedKeys.length,
      trimmedKeys: sortKeys(trimmedKeys),
      mistakesBytesBefore: Buffer.byteLength(mistakes),
      mistakesBytesAfter: Buffer.byteLength(newMistakes),
      stubBytesBefore: stubBytesIn(mistakes),
      stubBytesAfter: stubBytesIn(newMistakes),
      archiveBytesBefore: Buffer.byteLength(archive),
      archiveBytesAfter: Buffer.byteLength(newArchive),
      distinctKeysBefore: countDistinctEntryKeys(mistakes),
      distinctKeysAfter: countDistinctEntryKeys(newMistakes),
      archivedKeys: sortKeys(archivedKeys),
    },
  };
}

/**
 * Machine count-verify. Throws with an actionable message on any invariant
 * break so the CLI fails loud rather than silently writing a corrupted
 * MISTAKES.md or dropping an entry's history.
 */
export function verifyMistakesTrimStats(stats: MistakesTrimStats): string[] {
  const checks: string[] = [];

  // Growth is checked on ENTRY CONTENT only (total size minus the one
  // aggregate stub line) — the stub is a bounded, amortized one-time cost
  // (see buildStub doc) that CAN legitimately push total bytes up slightly
  // the very first time it's introduced on a small file, even though every
  // individual entry shrank. Content-loss safety is already covered by the
  // archive-never-shrinks and distinct-keys-preserved checks below; this
  // check targets the actual risk (entries ballooning), not the stub.
  const bodyBefore = stats.mistakesBytesBefore - stats.stubBytesBefore;
  const bodyAfter = stats.mistakesBytesAfter - stats.stubBytesAfter;
  if (bodyAfter > bodyBefore) {
    throw new Error(
      `Trim increased MISTAKES.md entry content (${bodyBefore} → ${bodyAfter} bytes, stub excluded) — ` +
        `aborting, no write performed.`
    );
  }
  checks.push(
    `MISTAKES.md entry content: ${bodyBefore} → ${bodyAfter} bytes, stub excluded (no growth) ✅`
  );

  // The step's own trigger (Step 9b) is TOTAL file size vs the 5000B cap, so
  // a run that actually trims something must reduce total size, stub
  // included — the stub-excluded check above is a narrower diagnostic that
  // cannot see stub overhead swallowing a trim's savings. DevGuru
  // poller-brain#328 round 1, on the real over-cap brain: a run reported
  // "entry content: ... (no growth) ✅" while the file that trigger this
  // step to fire actually grew 17977 → 18077 bytes. This check is what
  // would have caught it. (On a small fixture where a first-time stub
  // outweighs one short entry's savings, build the fixture at the size the
  // step actually triggers at — see mem-mistakes-trim.test.ts.)
  if (stats.trimmedEntries > 0 && stats.mistakesBytesAfter >= stats.mistakesBytesBefore) {
    throw new Error(
      `Trim reports ${stats.trimmedEntries} trimmed entries but MISTAKES.md total size did not shrink ` +
        `(${stats.mistakesBytesBefore} → ${stats.mistakesBytesAfter} bytes) — the stub's one-time cost ate the ` +
        `savings, or something else grew. Aborting, no write performed.`
    );
  }
  if (stats.trimmedEntries > 0) {
    checks.push(
      `MISTAKES.md total size: ${stats.mistakesBytesBefore} → ${stats.mistakesBytesAfter} bytes (shrank) ✅`
    );
  }

  if (stats.archiveBytesAfter < stats.archiveBytesBefore) {
    throw new Error(
      `Archive shrank (${stats.archiveBytesBefore} → ${stats.archiveBytesAfter} bytes) — archival must never ` +
        `remove content. Aborting, no write performed.`
    );
  }
  checks.push(`archive size: ${stats.archiveBytesBefore} → ${stats.archiveBytesAfter} bytes (no shrink) ✅`);

  if (stats.trimmedEntries !== stats.trimmedKeys.length) {
    throw new Error(
      `Count mismatch: trimmedEntries=${stats.trimmedEntries} but trimmedKeys.length=${stats.trimmedKeys.length}.`
    );
  }
  checks.push(`count: trimmedEntries(${stats.trimmedEntries}) == trimmedKeys.length ✅`);

  if (stats.distinctKeysBefore !== stats.distinctKeysAfter) {
    throw new Error(
      `Trim changed the set of distinct MEM-N keys cited in MISTAKES.md (${stats.distinctKeysBefore} → ` +
        `${stats.distinctKeysAfter}) — a pointer must keep citing its own key. Aborting, no write performed.`
    );
  }
  checks.push(`keys: ${stats.distinctKeysBefore} distinct MEM-N keys preserved in MISTAKES.md ✅`);

  return checks;
}
