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
 * The citation-detection heuristic (single-key-line evidence, multi-key-line
 * rejection, propose-only) lives in ./citation-detect.ts — shared with
 * mem-learnings-trim-core.ts (poller-brain#300), which applies the identical
 * heuristic to memory/core/LEARNINGS.md. See that module's doc comment for
 * the full false-positive-shape history. This module owns the
 * MEM_REGISTRY.md row format and the content-coverage guard (#505).
 *
 * This module is intentionally fs-free so the invariants can be unit-tested
 * against string fixtures without touching a real brain's memory/.
 */

import { MEM_ID_PATTERN, compareMemIds } from "./mem-id.js";

import {
  type DestinationFile,
  type Citation,
  type IndexRejection,
  firstCitations,
  extractHook,
  isReliableHook,
  sortKeys,
} from "./citation-detect.js";

export type { DestinationFile, IndexRejection };

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

/**
 * A key had a genuine single-key citation, but the extracted hook was too
 * short or fragment-shaped to trust as a description — excluded from
 * `candidates` rather than proposed with garbage content (DevGuru catch,
 * poller-brain#300 review round 3: live data produced hooks that were
 * literally the paragraph label "How to apply:", or a mid-sentence
 * fragment starting `> `).
 */
export interface UnreliableHook {
  key: string;
  file: string;
  line: number;
  lineText: string;
  hook: string;
}

const DATA_ROW_RE = new RegExp(String.raw`^\|\s*(${MEM_ID_PATTERN})\s*\|`);

/** Accept four/five bounded cells; escaped pipes and backslashes stay verbatim. */
function parseRegistryCells(line: string): string[] | null {
  const cells: string[] = [];
  let start = 0;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "|" && !escaped) {
      cells.push(line.slice(start, i));
      start = i + 1;
    }
    escaped = char === "\\" && !escaped;
  }
  cells.push(line.slice(start));
  if ((cells.length !== 6 && cells.length !== 7) || cells[0].trim() !== "" || cells[cells.length - 1].trim() !== "") return null;
  return cells;
}

/** Count key-bearing rows even if their remaining cells are malformed or already pointers. */
function findDuplicateKeys(lines: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of lines) {
    const key = line.match(DATA_ROW_RE)?.[1];
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

export interface ContentCoverage {
  key: string;
  file: string;
  line: number;
  status: "covered" | "rejected" | "no_verifiable_tokens";
  /** Legacy report field; always empty (coverage uses the complete body). */
  tokens: string[];
  /** Empty when covered, otherwise ["no-literal-match"]. */
  missingTokens: string[];
}
/** Only NFC, NBSP/thin-space -> space, trim and one initial list marker fold; tabs and space runs stay significant (fail closed). */
/** Only NFC, presentation whitespace and one initial list marker fold. */
function normalizeCoverageText(text: string): string {
  return text.normalize("NFC")
    .replace(/[\u00a0\u202f\u2009]/gu, " ")
    .trim()
    .replace(/^(?:[-*+]|[0-9]+\.) /u, "");
}

function checkCoverage(key: string, description: string, destination: string, citation: Citation): ContentCoverage {
  const body = normalizeCoverageText(description);
  // Empty bodies are not evidence. Never join lines or strip Markdown,
  // punctuation or a trailing citation to manufacture a match.
  const covered = body.length > 0 && destination.split(/\r\n|[\n\r]/u).some((line) => {
    const text = normalizeCoverageText(line);
    if (body === text) return true;
    for (const prefix of [`[${key}]`, `${key}:`]) {
      if (text.startsWith(prefix) && body === text.slice(prefix.length).trimStart()) return true;
    }
    return false;
  });
  return {
    key,
    file: citation.file,
    line: citation.line,
    status: covered ? "covered" : "rejected",
    tokens: [], // Retained for consumers of the original report shape; no token extraction.
    missingTokens: covered ? [] : ["no-literal-match"],
  };
}

/** Matches an already-trimmed pointer row's Description cell. */
export const POINTER_DESC_RE = /^see .+\.md( —| -)/;

export interface FindCandidatesResult {
  candidates: TrimCandidate[];
  /** Repeated registry keys, sorted; no row bearing one of these keys is eligible. */
  duplicateKeys: string[];
  /** Data rows seen (MEM-N rows in the registry, any status). */
  totalDataRows: number;
  /** Rows already a pointer (idempotence gate) — not re-proposed. */
  alreadyPointer: number;
  /** Destination lines skipped as index/pointer-shaped, not narrative evidence — surfaced so coverage loss is never silent. */
  indexRejections: IndexRejection[];
  /** Keys with a genuine citation but an unreliable extracted hook — excluded from `candidates`, surfaced so coverage loss is never silent. */
  unreliableHooks: UnreliableHook[];
  /** Additive machine-readable guard report; rejected rows are never candidates. */
  contentCoverage: ContentCoverage[];
}

/**
 * Find rows that are NOT yet a pointer and have a genuine single-key
 * citation somewhere in `destinations` and whose complete normalized
 * Description equals a complete normalized line in that citation's file,
 * optionally after removing one leading prefix for this key. Any failure
 * retains the full registry row.
 * Read-only — never mutates
 * `registry` and never decides what gets written. The caller (a human
 * reviewing the full `lineText` per candidate, or a step that already
 * knows a specific key/file/line is trustworthy) decides which candidates,
 * if any, to pass to `applyTrimCandidates`.
 */
export function findTrimCandidates(
  registry: string,
  destinations: DestinationFile[]
): FindCandidatesResult {
  const { citations, indexRejections } = firstCitations(destinations);
  const candidates: TrimCandidate[] = [];
  const unreliableHooks: UnreliableHook[] = [];
  const contentCoverage: ContentCoverage[] = [];
  const destinationText = new Map(destinations.map(({ file, text }) => [file, text]));
  const lines = registry.split("\n");
  const duplicateKeys = findDuplicateKeys(lines);
  let alreadyPointer = 0;
  let totalDataRows = 0;

  for (const line of lines) {
    const m = line.match(DATA_ROW_RE);
    if (!m) continue;
    totalDataRows++;
    const key = m[1];

    const cells = parseRegistryCells(line);
    // An unparseable row has no verifiable body and must fail coverage.
    const description = cells ? cells[cells.length - 2].trim() : "";
    if (POINTER_DESC_RE.test(description)) {
      alreadyPointer++;
      continue;
    }
    if (duplicateKeys.has(key)) continue; // a key alone cannot identify an approved row

    const citation = citations.get(key);
    if (!citation) continue; // no genuine single-key citation found — not (yet) promoted anywhere

    const coverage = checkCoverage(key, description, destinationText.get(citation.file) ?? "", citation);
    contentCoverage.push(coverage);
    if (coverage.status !== "covered") continue;

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
      file: citation.file,
      line: citation.line,
      lineText: citation.lineText,
      hook,
    });
  }

  return { candidates: sortCandidates(candidates), duplicateKeys: sortKeys([...duplicateKeys]),
    totalDataRows, alreadyPointer, indexRejections, unreliableHooks,
    contentCoverage: [...contentCoverage].sort((a, b) => compareMemIds(a.key, b.key)) };
}

function sortCandidates(candidates: TrimCandidate[]): TrimCandidate[] {
  return [...candidates].sort(
    (a, b) => compareMemIds(a.key, b.key)
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
 * touched — only Obsoleted, when present (→ `<file>:<line>`), and Description
 * (→ `see <file> — <hook>`) are rewritten. Rows whose key isn't in
 * `candidates` are left completely untouched, including rows that WERE
 * candidates but weren't approved.
 * Unparseable rows and all rows with duplicated keys are always retained,
 * including when the approved candidates came from an earlier registry.
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
  const lines = registry.split("\n");
  const duplicateKeys = findDuplicateKeys(lines);
  const trimmedKeys: string[] = [];
  let alreadyPointer = 0;
  let candidateRows = 0;
  let totalDataRows = 0;

  const outLines = lines.map((line) => {
    const m = line.match(DATA_ROW_RE);
    if (!m) return line;
    totalDataRows++;

    const cells = parseRegistryCells(line);
    const key = m[1];
    const description = cells ? cells[cells.length - 2].trim() : "";

    if (POINTER_DESC_RE.test(description)) {
      alreadyPointer++;
      return line;
    }
    candidateRows++;
    if (!cells || duplicateKeys.has(key)) return line;

    const candidate = byKey.get(key);
    if (!candidate) return line; // no approved candidate for this row — keep full narrative

    trimmedKeys.push(key);
    if (cells.length === 7) cells[4] = ` ${candidate.file}:${candidate.line} `;
    cells[cells.length - 2] = ` see ${candidate.file} — ${candidate.hook} `;
    return cells.join("|");
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
