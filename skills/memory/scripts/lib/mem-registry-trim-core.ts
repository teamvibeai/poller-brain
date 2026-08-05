/**
 * Pure trim logic for MEM_REGISTRY.md rows already promoted into consolidated
 * prose (core/semantic/episodic/procedural).
 *
 * Why a step exists: `MEM_REGISTRY.md` keeps the full-length narrative for
 * every row forever, even after that same content has been condensed into
 * prose and merged into `memory/core/LEARNINGS.md` (or a semantic/episodic/
 * procedural file) — the same fact then lives twice, once in each file, in
 * full length. This module rewrites a row to a short pointer once its
 * content has demonstrably been promoted, leaving the row's Key/Status/
 * Created columns untouched (works regardless of a brain's own lifecycle
 * status convention — see poller-brain#244 discussion, DevGuru catch: a
 * brain that marks promoted rows `PROMOTED` instead of `ACTIVE` still gets
 * trimmed, because detection never looks at Status).
 *
 * Reference: poller-brain#244. Sibling to mem-registry-archive-core.ts
 * (REMOVED-row relocation) — this instead targets ACTIVE-row bloat, the
 * actual current registry growth driver.
 *
 * Detection/apply is split into two functions on purpose — this is the
 * result of three adversarial review rounds with DevGuru, which surfaced
 * FOUR distinct false-positive shapes for "a destination file cites this
 * key, therefore it's safe to trim":
 *   1. episodic/ journals citing a key in bookkeeping context (a day-N
 *      countdown, a "merge this later" TODO, a status tally).
 *   2. core/semantic lines enumerating a "sibling MEM family" for future
 *      cleanup — the same failure as (1), proving the hazard is a line
 *      citing 2+ keys together, not the directory.
 *   3. (mitigated by the single-distinct-key-per-line gate below, which
 *      rejects any line citing 2+ keys as evidence for ALL of them.)
 *   4. a line citing exactly ONE key, but as an incidental "per this rule"
 *      justification inside an unrelated sentence/action-item — e.g. an
 *      episodic reflection recommendation citing a communication-style key
 *      to justify its own unrelated task, not restating that key's content.
 *      Real example (poller-brain#244 review): MEM-67 registry row is
 *      about "always send clickable GH links," but the single-key line
 *      that "cites" it is an unrelated reflection action item about a
 *      different batch-escalation task that merely says "...per [MEM-67]."
 * Every fix for one shape (directory exclusion, cluster-line rejection)
 * left the next shape unguarded — the class of failure ("cites the key" ≠
 * "is the key's condensed content") isn't fully closeable by a citation
 * heuristic without reading for meaning. So this module never auto-writes
 * from a blind scan. It only *proposes* candidates (`findTrimCandidates`);
 * writing is a separate step (`applyTrimCandidates`) given an explicit,
 * caller-approved candidate list — trusted either because a human reviewed
 * the full citing line before approving it (existing bloat backfill), or
 * because the caller just wrote and grep-verified that exact citation
 * itself moments earlier in the same run (fresh same-day promotion, no
 * scanning/ambiguity possible since the caller already knows the answer).
 *
 * This module is intentionally fs-free so the invariants can be unit-tested
 * against string fixtures without touching a real brain's memory/.
 */

/** A destination file's content, path relative to `memory/` (e.g. "core/LEARNINGS.md"). */
export interface DestinationFile {
  file: string;
  text: string;
}

/** A row whose key has a genuine single-key citation, proposed (not yet applied) as a trim. */
export interface TrimCandidate {
  key: string;
  file: string;
  /** 1-indexed line number within `file`. */
  line: number;
  /** Full citing line, verbatim — a reviewer should never have to dig through the destination file to judge this. */
  lineText: string;
  /** Deterministic short hook derived from `lineText`, used in the proposed Description. */
  hook: string;
}

const DATA_ROW_RE = /^\|\s*(MEM-\d+)\s*\|/;

/** Matches a compact citation cluster: `MEM-93`, `MEM-93/94/122`, `MEM-1,2,3`. */
const CLUSTER_CITE_RE = /\bMEM-(\d+(?:[/,]\d+)*)\b/g;

/** Matches an already-trimmed pointer row's Description cell. */
export const POINTER_DESC_RE = /^see .+\.md( —| -)/;

/** Parse every distinct MEM-N key cited in a line, expanding compact clusters. */
function distinctCitedKeysInLine(line: string): string[] {
  const keys = new Set<string>();
  CLUSTER_CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLUSTER_CITE_RE.exec(line))) {
    for (const n of m[1].split(/[/,]/)) keys.add(`MEM-${n}`);
  }
  return [...keys];
}

interface Citation {
  file: string;
  line: number;
  lineText: string;
}

/**
 * First citation location for every MEM-N key found across destination
 * files, scanned in file-path order then line order — deterministic so
 * repeated runs pick the same citation (idempotence).
 *
 * A line is only accepted as evidence if it cites EXACTLY ONE distinct
 * MEM-N key. A line citing 2+ keys (whether via one compact cluster like
 * `MEM-6/98/100/102` or via separate bracket tags on the same line like
 * `[MEM-172] ... ([MEM-166])`) is skipped entirely for ALL keys it
 * mentions — ambiguous whether it condenses any one of them specifically,
 * or is a family/sibling cross-reference listing. Scanning continues past
 * a rejected line in case the same key has a genuine single-key citation
 * elsewhere. Note this does NOT catch shape 4 above (single key, wrong
 * context) — that's why this is a candidate-finder, not an auto-writer.
 */
function firstCitations(destinations: DestinationFile[]): Map<string, Citation> {
  const found = new Map<string, Citation>();
  const sorted = [...destinations].sort((a, b) => a.file.localeCompare(b.file));
  for (const { file, text } of sorted) {
    const lines = text.split("\n");
    lines.forEach((lineText, idx) => {
      const keysOnLine = distinctCitedKeysInLine(lineText);
      if (keysOnLine.length !== 1) return; // 0 or 2+ keys — no evidence, or ambiguous cross-reference
      const key = keysOnLine[0];
      if (!found.has(key)) {
        found.set(key, { file, line: idx + 1, lineText });
      }
    });
  }
  return found;
}

/** Deterministic short hook extracted from a destination line, for the pointer's Description. */
function extractHook(lineText: string): string {
  let s = lineText.replace(/^\s*[-*]\s+/, "").trim();
  const bold = s.match(/\*\*(.+?)\*\*/);
  if (bold) return bold[1].trim();
  s = s
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return s.split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
}

function sortKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
}

export interface FindCandidatesResult {
  candidates: TrimCandidate[];
  /** Data rows seen (MEM-N rows in the registry, any status). */
  totalDataRows: number;
  /** Rows already a pointer (idempotence gate) — not re-proposed. */
  alreadyPointer: number;
}

/**
 * Find rows that are NOT yet a pointer and have a genuine single-key
 * citation somewhere in `destinations`. Read-only — never mutates
 * `registry` and never decides what gets written. The caller (a human
 * reviewing the full `lineText` per candidate, or a step that already
 * knows a specific key/file/line is trustworthy) decides which candidates,
 * if any, to pass to `applyTrimCandidates`.
 */
export function findTrimCandidates(
  registry: string,
  destinations: DestinationFile[]
): FindCandidatesResult {
  const citations = firstCitations(destinations);
  const candidates: TrimCandidate[] = [];
  let alreadyPointer = 0;
  let totalDataRows = 0;

  for (const line of registry.split("\n")) {
    const m = line.match(DATA_ROW_RE);
    if (!m) continue;
    totalDataRows++;
    const key = m[1];

    const cells = line.split("|");
    const description = (cells[5] ?? "").trim();
    if (POINTER_DESC_RE.test(description)) {
      alreadyPointer++;
      continue;
    }

    const citation = citations.get(key);
    if (!citation) continue; // no genuine single-key citation found — not (yet) promoted anywhere

    candidates.push({
      key,
      file: citation.file,
      line: citation.line,
      lineText: citation.lineText,
      hook: extractHook(citation.lineText),
    });
  }

  return { candidates: sortCandidates(candidates), totalDataRows, alreadyPointer };
}

function sortCandidates(candidates: TrimCandidate[]): TrimCandidate[] {
  return [...candidates].sort(
    (a, b) => parseInt(a.key.slice(4), 10) - parseInt(b.key.slice(4), 10)
  );
}

export interface TrimStats {
  totalDataRows: number;
  alreadyPointer: number;
  /** Rows not yet a pointer, that had a candidate available (whether or not it was applied). */
  candidateRows: number;
  /** Rows actually rewritten this call. */
  trimmedRows: number;
  trimmedKeys: string[];
  bytesBefore: number;
  bytesAfter: number;
}

export interface TrimResult {
  registry: string;
  stats: TrimStats;
}

/**
 * Rewrite MEM_REGISTRY.md rows for exactly the given `candidates` — an
 * explicit, caller-approved list (typically a subset, or all, of what
 * `findTrimCandidates` returned). Key/Status/Created columns are never
 * touched — only Obsoleted (→ `<file>:<line>`) and Description
 * (→ `see <file> — <hook>`) are rewritten. Rows whose key isn't in
 * `candidates` are left completely untouched, including rows that WERE
 * candidates but weren't approved.
 *
 * @param registry     current MEM_REGISTRY.md content
 * @param candidates   the exact set of trims to apply (caller decides trust)
 * @returns new registry content and machine-checkable stats
 */
export function applyTrimCandidates(
  registry: string,
  candidates: TrimCandidate[]
): TrimResult {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const trimmedKeys: string[] = [];
  let alreadyPointer = 0;
  let candidateRows = 0;
  let totalDataRows = 0;

  const outLines = registry.split("\n").map((line) => {
    const m = line.match(DATA_ROW_RE);
    if (!m) return line;
    totalDataRows++;

    const cells = line.split("|");
    const key = m[1];
    const keyCell = cells[1];
    const statusCell = cells[2] ?? "";
    const createdCell = cells[3] ?? "";
    const description = (cells[5] ?? "").trim();

    if (POINTER_DESC_RE.test(description)) {
      alreadyPointer++;
      return line;
    }
    candidateRows++;

    const candidate = byKey.get(key);
    if (!candidate) return line; // no approved candidate for this row — keep full narrative

    trimmedKeys.push(key);
    const newObsoleted = ` ${candidate.file}:${candidate.line} `;
    const newDescription = ` see ${candidate.file} — ${candidate.hook} `;
    return `|${keyCell}|${statusCell}|${createdCell}|${newObsoleted}|${newDescription}|`;
  });

  const newRegistry = outLines.join("\n");

  return {
    registry: newRegistry,
    stats: {
      totalDataRows,
      alreadyPointer,
      candidateRows,
      trimmedRows: trimmedKeys.length,
      trimmedKeys: sortKeys(trimmedKeys),
      bytesBefore: Buffer.byteLength(registry),
      bytesAfter: Buffer.byteLength(newRegistry),
    },
  };
}

/**
 * Convenience wrapper: find AND apply every candidate found by a blind
 * scan, with no review step in between. Kept for tests and for callers
 * that have already decided (out of band) that full trust is appropriate.
 * The CLI does NOT use this for its default backfill path — see
 * mem-registry-trim.ts for why (propose-only by default).
 */
export function trimPromotedRows(
  registry: string,
  destinations: DestinationFile[]
): TrimResult {
  const { candidates } = findTrimCandidates(registry, destinations);
  return applyTrimCandidates(registry, candidates);
}

/**
 * Machine count-verify. Throws with an actionable message on any invariant
 * break so the CLI / consolidate step fails loud rather than silently
 * writing a corrupted registry. Returns the list of assertions that passed.
 */
export function verifyTrimStats(stats: TrimStats): string[] {
  const checks: string[] = [];

  if (stats.bytesAfter > stats.bytesBefore) {
    throw new Error(
      `Trim increased registry size (${stats.bytesBefore} → ${stats.bytesAfter} bytes) — ` +
        `aborting, no write performed.`
    );
  }
  checks.push(`size: ${stats.bytesBefore} → ${stats.bytesAfter} bytes (no growth) ✅`);

  if (stats.trimmedRows !== stats.trimmedKeys.length) {
    throw new Error(
      `Count mismatch: trimmedRows=${stats.trimmedRows} but trimmedKeys.length=${stats.trimmedKeys.length}.`
    );
  }
  checks.push(`count: trimmedRows(${stats.trimmedRows}) == trimmedKeys.length ✅`);

  if (stats.alreadyPointer + stats.candidateRows !== stats.totalDataRows) {
    throw new Error(
      `Count mismatch: alreadyPointer(${stats.alreadyPointer}) + candidateRows(${stats.candidateRows}) ` +
        `!= totalDataRows(${stats.totalDataRows}).`
    );
  }
  checks.push(
    `count: alreadyPointer(${stats.alreadyPointer}) + candidateRows(${stats.candidateRows}) == totalDataRows(${stats.totalDataRows}) ✅`
  );

  return checks;
}
