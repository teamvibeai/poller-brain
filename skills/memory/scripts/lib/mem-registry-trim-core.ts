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
 * Detection (content-based, not status-based):
 *   1. Idempotence gate — a row already rewritten to a pointer (Description
 *      matches `see <file>.md — <hook>`) is left alone. A second consecutive
 *      run is a byte-identical no-op.
 *   2. Promotion gate — a row is a trim candidate only if at least one
 *      destination file (core/semantic/episodic/procedural) literally cites
 *      its MEM-N key. Citations are parsed as clusters (`MEM-93/94/122`,
 *      `MEM-1/2/3`, `MEM-46,92`), not matched as a bare `MEM-N` substring —
 *      a naive substring test silently misses every non-first key in a
 *      compact multi-key citation (DevGuru verified against a real 24-key
 *      sample: 23/24 matched naively, the one miss was a non-first key in a
 *      `MEM-116/117` citation).
 *
 * This module is intentionally fs-free so the invariants can be unit-tested
 * against string fixtures without touching a real brain's memory/.
 */

/** A destination file's content, path relative to `memory/` (e.g. "core/LEARNINGS.md"). */
export interface DestinationFile {
  file: string;
  text: string;
}

interface Citation {
  file: string;
  /** 1-indexed line number within `file`. */
  line: number;
  lineText: string;
}

const DATA_ROW_RE = /^\|\s*(MEM-\d+)\s*\|/;

/** Matches a compact citation cluster: `MEM-93`, `MEM-93/94/122`, `MEM-1,2,3`. */
const CLUSTER_CITE_RE = /\bMEM-(\d+(?:[/,]\d+)*)\b/g;

/** Matches an already-trimmed pointer row's Description cell. */
export const POINTER_DESC_RE = /^see .+\.md( —| -)/;

/** Parse every MEM-N key cited in a line, expanding compact clusters. */
function citedKeysInLine(line: string): string[] {
  const keys: string[] = [];
  CLUSTER_CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLUSTER_CITE_RE.exec(line))) {
    for (const n of m[1].split(/[/,]/)) keys.push(`MEM-${n}`);
  }
  return keys;
}

/**
 * First citation location for every MEM-N key found across destination
 * files, scanned in file-path order then line order — deterministic so
 * repeated runs pick the same citation (idempotence).
 */
function firstCitations(destinations: DestinationFile[]): Map<string, Citation> {
  const found = new Map<string, Citation>();
  const sorted = [...destinations].sort((a, b) => a.file.localeCompare(b.file));
  for (const { file, text } of sorted) {
    const lines = text.split("\n");
    lines.forEach((lineText, idx) => {
      for (const key of citedKeysInLine(lineText)) {
        if (!found.has(key)) {
          found.set(key, { file, line: idx + 1, lineText });
        }
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

export interface TrimStats {
  /** Data rows seen (MEM-N rows in the registry, any status). */
  totalDataRows: number;
  /** Rows already a pointer (idempotence gate) — untouched, counted as no-op. */
  alreadyPointer: number;
  /** Rows not yet a pointer, checked against destination citations. */
  candidateRows: number;
  /** Rows rewritten to a pointer this run. */
  trimmedRows: number;
  /** Keys rewritten this run, sorted numerically. */
  trimmedKeys: string[];
  bytesBefore: number;
  bytesAfter: number;
}

export interface TrimResult {
  registry: string;
  stats: TrimStats;
}

function sortKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
}

/**
 * Rewrite MEM_REGISTRY.md rows whose content has been promoted into a
 * destination file to a short pointer. Key/Status/Created columns are never
 * touched — only Obsoleted (→ `<file>:<line>`) and Description
 * (→ `see <file> — <hook>`) are rewritten.
 *
 * @param registry     current MEM_REGISTRY.md content
 * @param destinations current core/semantic/episodic/procedural file contents
 * @returns new registry content and machine-checkable stats
 */
export function trimPromotedRows(
  registry: string,
  destinations: DestinationFile[]
): TrimResult {
  const citations = firstCitations(destinations);
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

    const citation = citations.get(key);
    if (!citation) return line; // not (yet) promoted anywhere — keep full narrative

    trimmedKeys.push(key);
    const hook = extractHook(citation.lineText);
    const newObsoleted = ` ${citation.file}:${citation.line} `;
    const newDescription = ` see ${citation.file} — ${hook} `;
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
