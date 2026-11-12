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

export interface ContentCoverage {
  key: string;
  file: string;
  line: number;
  status: "covered" | "rejected" | "no_verifiable_tokens";
  tokens: string[];
  missingTokens: string[];
}

const URL_START_SRC = String.raw`(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/`;
const UNIT_SRC = String.raw`(?:%|‰|€|\$|°[CFK]|ns|us|µs|ms|s|sec|min|h|hr|hrs|days?|weeks?|months?|years?|[KMGTPEkmgtpe]i?[Bb]|bytes?|[kMG]?Hz|[munck]?m|[munpk]?g|[mun]?l|[mun]?L|[kM]?W|[kM]?V|[kM]?A|USD|EUR|CZK|Kč)(?![\p{L}\p{M}\p{N}_])`;
// Separators belong to a number only between digits. Never infer a locale
// or erase comma/dot positions: 1.234,56 != 1.234 56.
const NUMERIC_SRC = String.raw`[-+]?(?:\d+(?:[ ,.\u00a0\u202f]\d+)*|[.,]\d+)`;
const SEGMENT_SRC = String.raw`[\p{L}\p{M}\p{N}_@%+~.-]+`;
const PATH_SRC = String.raw`(?:(?:[A-Za-z]:[\/\\]|[.~]?[\/\\])${SEGMENT_SRC}(?:[\/\\]${SEGMENT_SRC})*|${SEGMENT_SRC}(?:[\/\\]${SEGMENT_SRC})+)`;
const FILENAME_SRC = String.raw`[\p{L}\p{M}\p{N}_@%+~.-]*\.[\p{L}][\p{L}\p{M}\p{N}_-]*`;
// Locate starts only. The readers consume each complete number/URL before
// any boundary decision, so a failed suffix cannot backtrack to a fragment.
const TOKEN_START_RE = new RegExp(
  `(${URL_START_SRC})|(\x60+)|` +
  String.raw`(?<![\p{L}\p{M}\p{N}_])(?:(${PATH_SRC}|${FILENAME_SRC})|(?<![./\\+-])([-+]?(?:\d|[.,](?=\d)))|([A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*)(?![\p{L}\p{M}\p{N}_]))`,
  "gu"
);

interface Token {
  value: string;
  kind: "url" | "number" | "text";
}

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenIdentity({ value, kind }: Token): string {
  if (kind === "url") return `url:${value}`;
  if (kind === "number") {
    const [, number, unit] = new RegExp(`^(${NUMERIC_SRC})(.*)$`, "u").exec(value)!;
    return `number:${number.replace(/[\u00a0\u202f]/g, " ")}:${unit.trim().toLowerCase()}`;
  }
  return `text:${normalizeToken(value)}`;
}

/** Read once, greedily, before deciding whether the span has a unit. */
function readNumber(text: string, start: number): Token {
  const number = new RegExp(`^${NUMERIC_SRC}`, "u").exec(text.slice(start))![0];
  const unit = new RegExp(`^[ \\t\\u00a0\\u202f]*${UNIT_SRC}`, "iu").exec(text.slice(start + number.length));
  const value = number + (unit?.[0] ?? "");
  const rest = text.slice(start + value.length);
  // A number attached to an identifier/path is not a standalone amount.
  // Preserve the complete spelling as text rather than emitting its digits.
  const tail = /^(?:[\p{L}\p{M}\p{N}_/\\-]|\.[\p{L}\p{M}\p{N}_])[\p{L}\p{M}\p{N}_./\\-]*/u.exec(rest)?.[0];
  return tail ? { value: value + tail, kind: "text" } : { value, kind: "number" };
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Uncertain delimiters retain the raw maximal span, never a prefix. */
function readUrl(text: string, start: number, inCode: boolean): string {
  const raw = /^\S+/.exec(text.slice(start))![0];
  if (inCode) return raw;
  const before = text.slice(0, start);
  // A code opener reaching this reader had no matching closing run.
  if (before.endsWith("`")) return raw;
  if (before.endsWith("<") && !isEscaped(text, start - 1)) {
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === ">" && !isEscaped(raw, i)) return raw.slice(0, i);
    }
    return raw;
  }
  if (before.endsWith("](")) {
    if (isEscaped(text, start - 1) || isEscaped(text, start - 2)) return raw;
    // A literal/escaped bracket sequence is not proof of a link boundary.
    let labelDepth = 1;
    for (let i = start - 3; i >= 0; i--) {
      if (isEscaped(text, i)) continue;
      if (text[i] === "]") labelDepth++;
      if (text[i] === "[" && --labelDepth === 0) break;
    }
    if (labelDepth !== 0) return raw;
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      if (isEscaped(raw, i)) continue;
      if (raw[i] === "(") depth++;
      if (raw[i] === ")") {
        if (depth === 0) return raw.slice(0, i);
        depth--;
      }
    }
    // Whitespace may precede a Markdown title. Missing/invalid closing
    // syntax keeps the same raw span, including any literal punctuation.
    return raw;
  }

  // Read surrounding wrappers as a stack. Remove a suffix only with its
  // matching opener; a mismatch retains the complete original span.
  const wrappers: string[] = [];
  let cursor = start;
  while (cursor > 0) {
    const prefix = text.slice(0, cursor);
    const marker = /(?:\*+|_+|~+|[([{])$/.exec(prefix)?.[0];
    if (!marker || isEscaped(text, cursor - marker.length)) break;
    if (!/^(?:\*{1,3}|_{1,3}|~~|[([{])$/.test(marker)) return raw;
    if (/^[_*~]/.test(marker) && /[\p{L}\p{N}_]/u.test(text[cursor - marker.length - 1] ?? "")) break;
    wrappers.push(marker);
    cursor -= marker.length;
  }
  let result = raw;
  const stripProse = () => {
    while (/[.,;:!?]$/.test(result) && !isEscaped(result, result.length - 1)) result = result.slice(0, -1);
  };
  stripProse();
  for (const open of wrappers.reverse()) {
    const close = ({ "(": ")", "[": "]", "{": "}" } as Record<string, string>)[open] ?? open;
    if (!result.endsWith(close) || isEscaped(result, result.length - close.length)) return raw;
    result = result.slice(0, -close.length);
    stripProse();
  }
  // Unmatched delimiters cannot safely be interpreted as prose. Escaped
  // delimiters are URL characters, and never affect the balancing stack.
  const stack: string[] = [];
  for (let i = 0; i < result.length; i++) {
    if (isEscaped(result, i)) continue;
    const char = result[i];
    if ("([{".includes(char)) stack.push(char);
    if (")]}".includes(char)) {
      const open = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[char];
      if (stack.pop() !== open) return raw;
    }
  }
  if (stack.length || /[*_~`<>]$/.test(result)) return raw;
  return result;
}

/**
 * Deterministic left-to-right lexing: consumed URLs, numbers, paths and
 * code spans are never rescanned for fragments. Both texts use the same
 * readers. URLs/numbers compare whole spans; filenames, paths and inline
 * identifiers retain fix1's case/whitespace/boundary behavior. All numbers
 * (including small integers) are guarded. Unknown URL syntax stays raw.
 */
function distinctiveTokens(description: string, inCode = false): Token[] {
  const tokens: Token[] = [];
  const seen = new Set<string>();
  function add(token: Token): void {
    const identity = tokenIdentity(token);
    if (seen.has(identity)) return;
    seen.add(identity);
    tokens.push(token);
  }
  const matcher = new RegExp(TOKEN_START_RE);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(description)) !== null) {
    const start = match.index;
    if (match[1]) {
      const value = readUrl(description, start, inCode);
      add({ value, kind: "url" });
      matcher.lastIndex = start + value.length;
    } else if (match[2]) {
      // Bound code before URL lexing. Closing backtick runs must have the
      // opener's exact length, so literal shorter runs remain URL content.
      const marker = match[2];
      const closing = new RegExp(`(?<!\x60)${marker}(?!\x60)`, "g");
      closing.lastIndex = matcher.lastIndex;
      const end = closing.exec(description);
      if (!end) continue;
      const value = description.slice(matcher.lastIndex, end.index).trim();
      matcher.lastIndex = end.index + marker.length;
      if (!value) continue;
      if (new RegExp(URL_START_SRC).test(value)) {
        for (const token of distinctiveTokens(value, true)) add(token);
      } else {
        const number = new RegExp(`^${NUMERIC_SRC}`, "u").test(value) ? readNumber(value, 0) : undefined;
        if (number?.value === value) add(number);
        else {
          add({ value, kind: "text" });
          // Inline phrases keep their existing text identity, but numeric
          // facts inside them must still pass whole-span comparison.
          for (const token of distinctiveTokens(value, true)) {
            if (token.kind === "number") add(token);
          }
        }
      }
    } else if (match[4]) {
      const token = readNumber(description, start);
      matcher.lastIndex = start + token.value.length;
      add(token);
    } else {
      const value = match[0].replace(/[.,;:]+$/, "");
      if (value && !/^[A-Z]$/.test(value)) add({ value, kind: "text" });
    }
  }
  return tokens;
}

function checkCoverage(key: string, description: string, destination: string, citation: Citation): ContentCoverage {
  const tokens = distinctiveTokens(description);
  const normalized = normalizeToken(destination);
  const spans = new Set(distinctiveTokens(destination).map(tokenIdentity));
  const missingTokens = tokens.filter((token) => {
    if (token.kind !== "text") return !spans.has(tokenIdentity(token));
    const pattern = normalizeToken(token.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Keep fix1's text matching (including unquoted inline identifiers).
    return !new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}_./\\-])${pattern}(?![\p{L}\p{M}\p{N}_/\\-]|\.[\p{L}\p{M}\p{N}_])`, "u").test(normalized);
  }).map((t) => t.value);
  return {
    key,
    file: citation.file,
    line: citation.line,
    status: missingTokens.length ? "rejected" : tokens.length ? "covered" : "no_verifiable_tokens",
    tokens: tokens.map((t) => t.value),
    missingTokens,
  };
}

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
  /** Additive machine-readable guard report; rejected rows are never candidates. */
  contentCoverage: ContentCoverage[];
}

/**
 * Find rows that are NOT yet a pointer and have a genuine single-key
 * citation somewhere in `destinations` and whose distinctive Description
 * tokens are all present in that citation's file. Zero-token rows retain
 * the citation-only behaviour, explicitly flagged in `contentCoverage`.
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
  let alreadyPointer = 0;
  let totalDataRows = 0;

  for (const line of registry.split("\n")) {
    const m = line.match(DATA_ROW_RE);
    if (!m) continue;
    totalDataRows++;
    const key = m[1];

    const cells = line.split("|");
    // Description is the final cell; retain embedded (escaped) pipes so
    // distinctive details after one cannot silently evade the guard.
    const description = cells.slice(5).join("|").replace(/\|\s*$/, "").trim();
    if (POINTER_DESC_RE.test(description)) {
      alreadyPointer++;
      continue;
    }

    const citation = citations.get(key);
    if (!citation) continue; // no genuine single-key citation found — not (yet) promoted anywhere

    const coverage = checkCoverage(key, description, destinationText.get(citation.file) ?? "", citation);
    contentCoverage.push(coverage);
    if (coverage.status === "rejected") continue;

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

  return { candidates: sortCandidates(candidates), totalDataRows, alreadyPointer, indexRejections, unreliableHooks,
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
