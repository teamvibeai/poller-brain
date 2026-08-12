/**
 * Shared "is this MEM-N key genuinely cited as condensed content elsewhere"
 * detection, factored out of mem-registry-trim-core.ts (poller-brain#244) so
 * a second trim script (mem-learnings-trim-core.ts, poller-brain#300) can
 * reuse the exact same hard-won heuristic instead of re-deriving it and
 * re-discovering the same false-positive shapes.
 *
 * Detection is content-based, not status-based: a citation is only trusted
 * as evidence if its line cites EXACTLY ONE distinct MEM-N key. A line
 * citing 2+ keys (a compact cluster like `MEM-6/98/100` or separate bracket
 * tags like `[MEM-172] ... ([MEM-166])`) is rejected as evidence for ALL
 * keys it mentions — three adversarial DevGuru review rounds on the
 * MEM_REGISTRY.md version (poller-brain#244) found this ambiguity class
 * unrecoverable by regex alone (a single-key line can still be an
 * incidental "per this rule" justification rather than the key's actual
 * condensed content), which is why callers must treat this module's output
 * as *candidates for human review*, never as auto-write evidence.
 *
 * Intentionally fs-free — pure string fixtures, unit-testable without a
 * real brain's memory/.
 */

/** A destination file's content, path relative to `memory/` (e.g. "semantic/foo.md"). */
export interface DestinationFile {
  file: string;
  text: string;
}

export interface Citation {
  file: string;
  line: number;
  lineText: string;
  /**
   * Nearest markdown heading (`#` through `######`) above `line` within the
   * same destination file, text with the `#` markers stripped — null if no
   * heading precedes this line. Governs until the NEXT heading (standard
   * markdown section semantics), regardless of blank lines in between — a
   * real entry is routinely `### Title` / blank / `**Rule:** ...` / blank /
   * `**How to apply:** ...`, so a heading must survive blank-line gaps to
   * govern its own entry's citations (DevGuru catch, poller-brain#300
   * review round 4: an earlier blank-line-stops-the-scan boundary rejected
   * the heading for exactly this shape on his real brain, falling through
   * to a prose fallback that kept producing garbage in a new shape each
   * round). This is now the ONLY hook source — see `extractHook`.
   */
  heading: string | null;
}

/** A single-key destination line skipped because it looks like an index/pointer row, not narrative. */
export interface IndexRejection {
  key: string;
  file: string;
  line: number;
  lineText: string;
}

export interface CitationScan {
  citations: Map<string, Citation>;
  /**
   * Single-key lines that were skipped for being index-shaped, reported so
   * a caller never silently loses coverage (DevGuru catch, poller-brain#300
   * review round 2: an unreported rejection reads as "nothing was there",
   * indistinguishable from a genuinely clean scan).
   */
  indexRejections: IndexRejection[];
}

/** Matches a compact citation cluster: `MEM-93`, `MEM-93/94/122`, `MEM-1,2,3`. */
const CLUSTER_CITE_RE = /\bMEM-(\d+(?:[/,]\d+)*)\b/g;

/** A markdown table row — starts (ignoring leading whitespace) with `|`. */
const TABLE_ROW_RE = /^\s*\|/;

/** A path/filename pointing at another markdown file (`semantic/foo.md`, `see bar.md`, `kb/x.md`). */
const FILE_PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)*\.md\b/;

/**
 * Matches a destination line that is itself a pointer/index entry (an
 * `MEM-N → destination` lookup row) rather than condensed narrative prose.
 * poller-brain#300 DevGuru catch (review round 1): a file like an MEM-key →
 * destination index table has one single-key line per row — passes the
 * single-key evidence test, but citing it as "condensed content" is
 * backwards, it's the index ITSELF pointing elsewhere, not a narrative that
 * absorbed the key's content. Confirmed false-positive in production
 * (2026-08-12, mem-registry-trim.ts proposed 10 candidates off an index
 * file, all 10 rejected on review).
 *
 * Round 2 (DevGuru): the original regex over-fit the one observed table
 * shape (`kb/` paths, or a literal `| MEM-N |` first cell). Generalized to
 * two cheap, independent signals ORed with the original narrative-pointer
 * phrasing: (a) the line is a markdown table row at all (`^\s*\|`), AND
 * (b) it contains a path to another `.md` file — combined, these catch any
 * "key → destination" index table regardless of column layout, without
 * flagging a table row that happens to merely *mention* a key mid-prose.
 */
function isIndexShapedLine(line: string): boolean {
  if (/→\s*see\s|(?:^|\s)see\s+\S+\.md\b/.test(line)) return true;
  return TABLE_ROW_RE.test(line) && FILE_PATH_RE.test(line);
}

/** Parse every distinct MEM-N key cited in a line, expanding compact clusters. */
export function distinctCitedKeysInLine(line: string): string[] {
  const keys = new Set<string>();
  CLUSTER_CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLUSTER_CITE_RE.exec(line))) {
    for (const n of m[1].split(/[/,]/)) keys.add(`MEM-${n}`);
  }
  return [...keys];
}

const HEADING_LINE_RE = /^#{1,6}\s+(.+?)\s*$/;

/**
 * Nearest heading text governing `lineIdx` (0-indexed) in `lines`, `#`
 * markers stripped — null if none precedes it anywhere in the file. A
 * heading governs everything below it up to the next heading (or end of
 * file) — plain markdown section scoping, not a heuristic — so blank
 * lines/paragraph breaks in between do NOT end its reach (poller-brain#300
 * review round 4: the correct boundary is the next heading, not a blank
 * line; bounding on blank lines rejected the governing heading for the
 * routine `### Title` / blank / `**Rule:**` / blank / `**How to
 * apply:**` shape). Trade-off accepted deliberately: a stray unrelated
 * paragraph inside a heading's section (no heading of its own) inherits
 * that heading as its hook too — imprecise but never garbage, which is the
 * property this function optimizes for.
 */
function nearestHeading(lines: string[], lineIdx: number): string | null {
  for (let i = lineIdx; i >= 0; i--) {
    const m = HEADING_LINE_RE.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * First citation location for every MEM-N key found across `destinations`,
 * scanned in file-path order then line order — deterministic so repeated
 * runs pick the same citation (idempotence). Only single-key lines count as
 * evidence; see module doc for why. Index-shaped lines are excluded from
 * `citations` but reported in `indexRejections`, never silently dropped.
 */
export function firstCitations(destinations: DestinationFile[]): CitationScan {
  const found = new Map<string, Citation>();
  const indexRejections: IndexRejection[] = [];
  const sorted = [...destinations].sort((a, b) => a.file.localeCompare(b.file));
  for (const { file, text } of sorted) {
    const lines = text.split("\n");
    lines.forEach((lineText, idx) => {
      const keysOnLine = distinctCitedKeysInLine(lineText);
      if (keysOnLine.length !== 1) return; // 0 or 2+ keys — no evidence, or ambiguous cross-reference
      const key = keysOnLine[0];
      if (isIndexShapedLine(lineText)) {
        indexRejections.push({ key, file, line: idx + 1, lineText });
        return;
      }
      if (!found.has(key)) {
        found.set(key, { file, line: idx + 1, lineText, heading: nearestHeading(lines, idx) });
      }
    });
  }
  return { citations: found, indexRejections };
}

/**
 * A hook failing this is a garbage fragment rather than a description — the
 * caller must treat it as unreliable rather than propose it. Each check
 * traces to a real observed shape (DevGuru catches, poller-brain#300
 * review rounds 3-4, live data): too short or a bare `>`/`|` start ("MEM-41
 * → wrapped blockquote continuation"); a stray `**` marker ("MEM-115 →
 * `2026-08-02 (MEM-115):** caught under-applying...`" — an orphaned bold
 * marker, not real content); a lowercase start ("MEM-124 → `around.
 * (MEM-124, ...`", "MEM-7 → `transparently in-thread...`" — both start
 * mid-sentence, not at a title); a bare citation parenthesis as the whole
 * hook ("MEM-95 → `(MEM-95, 2026-07-24.)`" — the citation ITSELF, zero
 * description content).
 */
export function isReliableHook(hook: string): boolean {
  const s = hook.trim();
  if (s.length < 15) return false;
  if (/^[>|(]/.test(s)) return false;
  if (s.includes("**")) return false;
  if (/^[a-z]/.test(s)) return false;
  return true;
}

/**
 * Deterministic short hook for a proposed pointer, from a destination
 * citation. The citation's nearest governing heading is the ONLY source —
 * no fallback to the citing line's bold spans or plain text. Round 3 tried
 * a heading-first-then-fallback design; round 4 (DevGuru, live data on his
 * brain) found the fallback kept reproducing garbage in a new shape every
 * round (label bolds, then orphaned `**` markers, mid-sentence fragments,
 * bare citation parens) — a citing line's prose is, structurally, not a
 * title, and no amount of pattern-matching makes it one. A heading is
 * either present (trustworthy by construction: it's the entry's own title)
 * or absent, in which case the caller excludes the key via
 * `isReliableHook`/`unreliableHooks` rather than guessing from prose.
 */
export function extractHook(citation: Citation): string | null {
  return citation.heading;
}

export function sortKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
}
