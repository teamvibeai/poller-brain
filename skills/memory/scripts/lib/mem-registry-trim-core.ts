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
 * the full false-positive-shape history. This module only owns the
 * MEM_REGISTRY.md-specific row format (pipe-table parsing/rewriting).
 *
 * This module is intentionally fs-free so the invariants can be unit-tested
 * against string fixtures without touching a real brain's memory/.
 */

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

const DATA_ROW_RE = /^\|\s*(MEM-\d+)\s*\|/;

/** Matches an already-trimmed pointer row's Description cell. */
export const POINTER_DESC_RE = /^see .+\.md( —| -)/;

export interface FindCandidatesResult {
  candidates: TrimCandidate[];
  /** Data rows seen (MEM-N rows in the registry, any status). */
  totalDataRows: number;
  /** Rows already a pointer (idempotence gate) — not re-proposed. */
  alreadyPointer: number;
  /** Destination lines skipped as index/pointer-shaped, not narrative evidence — surfaced so coverage loss is never silent. */
  indexRejections: IndexRejection[];
  /** Keys with a genuine citation but an unreliable extracted hook — excluded from `candidates`, surfaced so coverage loss is never silent. */
  unreliableHooks: UnreliableHook[];
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
  const { citations, indexRejections } = firstCitations(destinations);
  const candidates: TrimCandidate[] = [];
  const unreliableHooks: UnreliableHook[] = [];
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

  return { candidates: sortCandidates(candidates), totalDataRows, alreadyPointer, indexRejections, unreliableHooks };
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
