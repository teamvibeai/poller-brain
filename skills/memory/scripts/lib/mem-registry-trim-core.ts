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
const URL_SRC = String.raw`${URL_START_SRC}[^\s<>"\x60|]+`;
const UNIT_SRC = String.raw`(?:%|‰|°[CFK]|(?:ns|us|µs|ms|s|sec|min|h|hr|hrs|days?|weeks?|months?|years?|[KMGTPEkmgtpe]i?[Bb]|bytes?|[kMG]?Hz|[munck]?m|[munpk]?g|[mun]?l|[mun]?L|[kM]?W|[kM]?V|[kM]?A|USD|EUR|CZK|Kč)(?![\p{L}\p{M}\p{N}_]))`;
const NUMERIC_SRC = String.raw`[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)`;
const NUMBER_SRC = String.raw`(?:${NUMERIC_SRC}\s*${UNIT_SRC}|[-+]?(?:\d*[.,]\d+|\d{3,}))`;
const SEGMENT_SRC = String.raw`[\p{L}\p{M}\p{N}_@%+~.-]+`;
const PATH_SRC = String.raw`(?:(?:[A-Za-z]:[\/\\]|[.~]?[\/\\])${SEGMENT_SRC}(?:[\/\\]${SEGMENT_SRC})*|${SEGMENT_SRC}(?:[\/\\]${SEGMENT_SRC})+)`;
const FILENAME_SRC = String.raw`[\p{L}\p{M}\p{N}_@%+~.-]*\.[\p{L}][\p{L}\p{M}\p{N}_-]*`;
const TOKEN_RE = new RegExp(
  `${URL_SRC}|\x60([^\x60\n]+)\x60|` +
  String.raw`(?<![\p{L}\p{M}\p{N}_])(?:${PATH_SRC}|${FILENAME_SRC}|${NUMBER_SRC}|[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*)(?![\p{L}\p{M}\p{N}_])`,
  "gu"
);

interface Token {
  value: string;
  kind: "url" | "number" | "text";
}

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Explicit URL boundaries preserve literal punctuation; bare URLs use prose boundaries. */
function cleanUrl(url: string, before: string, inCode: boolean): string {
  if (inCode || before.endsWith("<")) return url;
  if (before.endsWith("](")) {
    // The first unmatched ')' closes the Markdown destination. Balanced
    // parentheses inside it belong to the URL, as does a literal final dot.
    let depth = 0;
    for (let i = 0; i < url.length; i++) {
      if (url[i] === "(") depth++;
      else if (url[i] === ")") {
        if (depth === 0) return url.slice(0, i);
        depth--;
      }
    }
    // Whitespace can end the URL before an optional Markdown link title.
    return url;
  }
  let result = url;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/[.,;:!?]+$/, "");
    for (const marker of ["**", "__"]) {
      if (before.endsWith(marker) && result.endsWith(marker)) result = result.slice(0, -marker.length);
    }
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      if (result.endsWith(close) && result.split(close).length > result.split(open).length) {
        result = result.slice(0, -1);
      }
    }
  } while (result !== previous);
  return result;
}

/**
 * Deterministic, left-to-right extraction from the Description cell only:
 * scheme:// URLs; nonempty inline backtick spans without URLs (spans with
 * URLs retain literal punctuation); Unicode slash/backslash paths and
 * dotted filenames (including bare .xls); numbers with >=3 digits, a
 * dot/comma decimal, or a unit from UNIT_SRC; and >=2-character ASCII
 * ALL-CAPS identifiers (digits, internal hyphens/underscores allowed).
 * Earlier alternatives consume their whole span: URL digits/filenames
 * and inline code are not also emitted as smaller tokens. Plain small
 * integers and ordinary prose are ignored. Duplicates retain their first
 * spelling/order, folding case/whitespace except in URLs. This is a
 * conservative syntactic guard, not proof of semantic equivalence.
 */
function distinctiveTokens(description: string, inCode = false): Token[] {
  const tokens: Token[] = [];
  const seen = new Set<string>();
  function add(token: Token): void {
    const identity = `${token.kind === "url" ? "url" : "text"}:${token.kind === "url" ? token.value : normalizeToken(token.value)}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    tokens.push(token);
  }
  const matcher = new RegExp(TOKEN_RE);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(description)) !== null) {
    let value = (match[1] ?? match[0]).trim();
    if (match[1] !== undefined && new RegExp(URL_START_SRC).test(value)) {
      // Consume the complete backtick span, then scan its contents. This
      // also keeps the closing backtick from pairing with the next span.
      for (const token of distinctiveTokens(value, true)) add(token);
      continue;
    }
    const kind = new RegExp(`^${URL_START_SRC}`).test(value) ? "url" :
      match[1] === undefined && new RegExp(`^${NUMBER_SRC}$`, "u").test(value) ? "number" : "text";
    if (kind === "url") {
      value = cleanUrl(value, description.slice(0, match.index), inCode);
      // Resume at the actual URL boundary so adjacent Markdown links or
      // other details after its closing delimiter are still scanned.
      matcher.lastIndex = match.index + value.length;
    } else if (match[1] === undefined) value = value.replace(/[.,;:]+$/, "");
    if (!value || (match[1] === undefined && /^[A-Z]$/.test(value))) continue;
    add({ value, kind });
  }
  return tokens;
}

function checkCoverage(key: string, description: string, destination: string, citation: Citation): ContentCoverage {
  const tokens = distinctiveTokens(description);
  const normalized = normalizeToken(destination);
  // Exact URL tokens, rather than substring matches: /source != /source-old.
  const urls = new Set(distinctiveTokens(destination).filter((t) => t.kind === "url").map((t) => t.value));
  const missingTokens = tokens.filter(({ value, kind }) => {
    if (kind === "url") return !urls.has(value);
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let pattern = escape(normalizeToken(value));
    if (kind === "number") {
      const parts = new RegExp(`^(${NUMERIC_SRC})(.*)$`).exec(normalizeToken(value))!;
      pattern = escape(parts[1]) + (parts[2].trim() ? "\\s*" + escape(parts[2].trim()) : "");
      // A comma/dot followed by digits continues a decimal or grouped
      // number; sentence punctuation alone can still delimit an amount.
      pattern = String.raw`(?<!\d[.,])${pattern}(?![.,]\d)`;
    }
    // Do not accept identifiers, paths or numbers merely as substrings of
    // longer tokens (API in APIS, 123 in 1234, foo.md in foo.md.bak).
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
