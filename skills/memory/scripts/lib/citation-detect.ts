/**
 * Shared "is this MEM-N key genuinely cited as condensed content elsewhere"
 * detection, factored out of mem-registry-trim-core.ts (poller-brain#244) so
 * a second trim script (mem-learnings-trim-core.ts, poller-brain#300) can
 * reuse the exact same hard-won heuristic instead of re-deriving it and
 * re-discovering the same false-positive shapes.
 *
 * Destination ownership is required: the nearest visible heading must name
 * exactly the cited key, with no obsolete owner. Generic/unkeyed nested
 * headings do not inherit ownership. Fenced code and HTML comments are ignored.
 *
 * Detection is content-based, not status-based: a citation is only trusted
 * as evidence if its line cites EXACTLY ONE distinct MEM-N key, OR cites 2+
 * keys but exactly one of them sits in the line's leading SUBJECT position
 * (poller-brain#334: `- **[MEM-53] Title** ... mentions MEM-52 too` is
 * genuine evidence for MEM-53, not rejected outright, because MEM-53 is
 * unambiguously this line's subject and MEM-52 is only an incidental
 * cross-reference later in the sentence — see `subjectPositionKey`). A line
 * citing 2+ keys with NO single leading-tag subject (a compact cluster like
 * `MEM-6/98/100`, or a citation buried mid-sentence in "per this rule
 * (MEM-6/98/100)"-style justification prose) is still rejected as evidence
 * for ALL keys it mentions — three adversarial DevGuru review rounds on the
 * MEM_REGISTRY.md version (poller-brain#244) found THAT ambiguity class
 * unrecoverable by regex alone (a single-key line can still be an
 * incidental justification rather than the key's actual condensed content),
 * which is why callers must treat this module's output as *candidates for
 * human review*, never as auto-write evidence.
 *
 * Intentionally fs-free — pure string fixtures, unit-testable without a
 * real brain's memory/.
 */

import { MEM_ID_PATTERN, MEM_CITATION_PATTERN, compareMemIds } from "./mem-id.js";

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

/** Accepted evidence includes only visible text in its nearest heading's section. */
export interface OwnedCitation extends Citation {
  sectionText: string;
}

export interface OwnershipRejection {
  key: string;
  file: string;
  line: number;
  lineText: string;
  heading: string | null;
  owners: string[];
  reason: "missing-heading" | "missing-key" | "multi-key" | "foreign-key" | "obsolete-owner";
}

/** A single-key destination line skipped because it looks like an index/pointer row, not narrative. */
export interface IndexRejection {
  key: string;
  file: string;
  line: number;
  lineText: string;
}

export interface CitationScan {
  citations: Map<string, OwnedCitation>;
  ownershipRejections: OwnershipRejection[];
  /**
   * Single-key lines that were skipped for being index-shaped, reported so
   * a caller never silently loses coverage (DevGuru catch, poller-brain#300
   * review round 2: an unreported rejection reads as "nothing was there",
   * indistinguishable from a genuinely clean scan).
   */
  indexRejections: IndexRejection[];
}

/** Matches a compact citation cluster: `MEM-93`, `MEM-93/94/122`, `MEM-1,2,3`. */
const CLUSTER_CITE_RE = new RegExp(String.raw`\b${MEM_CITATION_PATTERN}\b`, "g");

/** A markdown table row — starts (ignoring leading whitespace) with `|`. */
const TABLE_ROW_RE = /^\s*\|/;

/** A path/filename pointing at another markdown file (`semantic/foo.md`, `see bar.md`, `kb/x.md`). */
const FILE_PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)*\.md\b/;

/** A `[[wikilink]]`-style cross-reference token. */
const WIKILINK_RE = /\[\[[^\]]+\]\]/;

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
 *
 * poller-brain#334 (DevGuru catch, review round 1, to-fix 2): subject-
 * position widened evidence into a "Cross-refs"-style bullet that lists
 * several `[[wikilink]]` targets alongside citations (e.g. `[MEM-71]
 * [[iam-quota-strategy]] · [MEM-73] (this mechanism) · [[poller-error-
 * reporting]]`) — a pointer to elsewhere, same as an `.md` path, just
 * bracket syntax instead of a filename. Round 2 (DevGuru): a bare
 * `WIKILINK_RE.test(line)` over-fit — it flagged EVERY line that merely
 * contains a `[[wikilink]]` anywhere, not just a line that IS a list of
 * links. Measured regression against `main` on 4 brains: +27 wrongly
 * rejected lines, 3 keys (MEM-124/279/283) lost all citation evidence,
 * including the exact subject-position narrative shape #334 exists to
 * unlock (`- **[MEM-124] PLNÁ odpovědnost předána JARVISovi...** (viz
 * `[[codex-cli-integration]]`)` — one wikilink mid-sentence, not a
 * pointer row). Narrowed to require the line be MOSTLY link/citation
 * syntax: strip wikilinks, MEM-N citations, and inline code, then only
 * flag if under 30 chars of prose remain (calibrated against 133 real
 * rejection lines across the same 4-brain corpus — a starting point, not
 * an authoritative constant; DevGuru measured 0 lost keys, +5 correctly
 * rejected true pointer lines with this threshold).
 */
function residualProse(line: string): string {
  return line
    .replace(/\[\[[^\]]+\]\]/g, "")
    .replace(new RegExp("`?\\[?" + MEM_CITATION_PATTERN + "(?::obsolete)?\\]?`?", "g"), "")
    .replace(/`[^`]*`/g, "")
    .replace(/[\s\-*#·—–|:;,.()§→>]+/g, " ")
    .trim();
}

function isIndexShapedLine(line: string): boolean {
  if (/→\s*see\s|(?:^|\s)see\s+\S+\.md\b/.test(line)) return true;
  if (WIKILINK_RE.test(line) && residualProse(line).length < 30) return true;
  return TABLE_ROW_RE.test(line) && FILE_PATH_RE.test(line);
}

/** Parse every distinct MEM-N key cited in a line, expanding compact clusters. */
export function distinctCitedKeysInLine(line: string): string[] {
  const keys = new Set<string>();
  CLUSTER_CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLUSTER_CITE_RE.exec(line))) {
    const [first, ...rest] = m[0].split(/[/,]/);
    keys.add(first);
    for (const n of rest) keys.add(`MEM-${n}`);
  }
  return [...keys];
}

// Accept possible fences at any container indentation, including list-marker
// lines and blockquotes. An indented fence must never expose example coverage.
const FENCE_OPEN_RE = /^((?:[ \t>]|(?:[-+*]|\d+[.)])(?=[ \t]))*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^([ \t>]*)(`{3,}|~{3,})[ \t]*$/;

/** Find an exact-length closing backtick run within this inline block. */
function codeSpanEnd(lines: string[], row: number, pos: number, length: number): { row: number; pos: number } | undefined {
  const quotePrefix = (line: string) => /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0] ?? "";
  const quoteDepth = (prefix: string) => [...prefix].filter((char) => char === ">").length;
  const depth = quoteDepth(quotePrefix(lines[row]));
  for (let i = row; i < lines.length; i++) {
    const line = lines[i];
    if (i > row) {
      // Inline spans cannot cross block boundaries. Do not pair an unmatched
      // backtick with one in a later heading, fence, list item or HTML block.
      const quote = quotePrefix(line);
      // A paragraph may lazily continue without repeating every quote marker;
      // a deeper quote starts a new block. Whitespace around > may also vary.
      if (quoteDepth(quote) > depth) return undefined;
      const content = line.slice(quote.length);
      if (!content.trim() || headingText(content) !== null || FENCE_OPEN_RE.test(line) ||
        /^ {0,3}(?:<|[-+*](?:[ \t]|$)|\d+[.)][ \t]|(?:=+|-+)[ \t]*$)/.test(content)) return undefined;
    }
    const runs = /`+/g;
    runs.lastIndex = i === row ? pos : 0;
    let run: RegExpExecArray | null;
    // Within a code span backslashes are literal, so even \` can close it.
    while ((run = runs.exec(line))) {
      if (run[0].length === length) return { row: i, pos: runs.lastIndex };
    }
  }
  return undefined;
}

/**
 * Strip HTML comments and fenced code before interpreting headings or citations.
 * Comments only open outside matched inline code spans and backslash escapes.
 * Preserve line count and spaces where comments occur, so hidden text cannot
 * supply ownership, coverage, or join two visible tokens into a new MEM ID.
 */
function visibleLines(text: string): string[] {
  let comment = false;
  let fence: { marker: string; length: number; prefix: string } | undefined;
  let codeEnd: { row: number; pos: number } | undefined;
  const lines = text.split(/\r\n|[\n\r]/u);
  return lines.map((line, row) => {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      // Only resume coverage at an unambiguous closing container prefix.
      // A deeper/uncertain delimiter stays hidden along with the rest of the
      // block (possibly to EOF), rather than exposing example code as prose.
      if (close && close[1] === fence.prefix && close[2][0] === fence.marker && close[2].length >= fence.length) fence = undefined;
      return "";
    }
    // A fence's contents are literal, including apparent comment delimiters.
    const open = !comment && !codeEnd && FENCE_OPEN_RE.exec(line);
    if (open && (open[2][0] !== "`" || !open[3].includes("`"))) {
      fence = { marker: open[2][0], length: open[2].length,
        prefix: open[1].replace(/(?:[-+*]|\d+[.)])(?=[ \t])/g, (marker) => " ".repeat(marker.length)) };
      return "";
    }
    let visible = "";
    let pos = 0;
    while (pos < line.length) {
      if (comment) {
        // HTML comment contents are raw: backticks/backslashes cannot escape
        // their closing delimiter once a real comment has opened.
        const end = line.indexOf("-->", pos);
        if (end < 0) break;
        visible += " ".repeat(end + 3 - pos);
        pos = end + 3;
        comment = false;
      } else if (codeEnd) {
        const end = codeEnd.row === row ? codeEnd.pos : line.length;
        visible += line.slice(pos, end);
        pos = end;
        if (codeEnd.row === row) codeEnd = undefined;
      } else if (line[pos] === "\\") {
        // Consuming pairs also handles odd/even runs of escaping backslashes.
        visible += line.slice(pos, pos + 2);
        pos += 2;
      } else if (line[pos] === "`") {
        const run = /^`+/.exec(line.slice(pos))![0];
        codeEnd = codeSpanEnd(lines, row, pos + run.length, run.length);
        visible += run;
        pos += run.length;
      } else if (line.startsWith("<!--", pos)) {
        comment = true;
      } else {
        visible += line[pos++];
      }
    }
    return visible;
  });
}

const OBSOLETE_OWNER_RE = new RegExp(String.raw`\b${MEM_CITATION_PATTERN}:obsolete\b`);

/** ATX headings, including empty boundaries, optional indentation/closing hashes. */
function headingText(line: string): string | null {
  const m = /^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/.exec(line.replace(/^\ufeff/, ""));
  return m ? (m[1] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim() : null;
}

/**
 * First eligible citation per key in file/line order. A line must pass the
 * single-key/leading-subject and index rules AND its nearest visible heading
 * must name exactly that key. Headings can themselves cite their own key.
 * Unkeyed nested headings do not inherit ownership from an ancestor.
 * Rejections never consume the key: a later correctly owned section can win.
 */
export function firstCitations(destinations: DestinationFile[]): CitationScan {
  const found = new Map<string, OwnedCitation>();
  const indexRejections: IndexRejection[] = [];
  const ownershipRejections: OwnershipRejection[] = [];
  const sorted = [...destinations].sort((a, b) => a.file.localeCompare(b.file));
  for (const { file, text } of sorted) {
    const lines = visibleLines(text);
    const rawLines = text.split(/\r\n|[\n\r]/u);
    let heading: string | null = null;
    let sectionStart = 0;
    const sections = lines.map(headingText);
    // Precompute each section's end once; hidden headings never split a section.
    const sectionEnds = new Map<number, number>();
    for (let i = 0; i < lines.length; i++) {
      if (sections[i] !== null) {
        sectionEnds.set(sectionStart, i);
        sectionStart = i;
      }
    }
    sectionEnds.set(sectionStart, lines.length);
    sectionStart = 0;
    lines.forEach((visible, idx) => {
      if (sections[idx] !== null) { heading = sections[idx]; sectionStart = idx; }
      const keysOnLine = distinctCitedKeysInLine(visible);
      if (keysOnLine.length === 0) return;
      const key = keysOnLine.length === 1 ? keysOnLine[0] : subjectPositionKey(visible);
      if (key === null) return; // ambiguous cross-reference, no sole subject
      const lineText = rawLines[idx];
      if (isIndexShapedLine(visible)) {
        indexRejections.push({ key, file, line: idx + 1, lineText });
        return;
      }
      const owners = distinctCitedKeysInLine(heading ?? "");
      const reason = heading === null ? "missing-heading"
        : owners.length === 0 ? "missing-key"
        : owners.length > 1 ? "multi-key"
        : owners[0] !== key ? "foreign-key"
        : OBSOLETE_OWNER_RE.test(heading) ? "obsolete-owner"
        : null;
      if (reason) {
        ownershipRejections.push({ key, file, line: idx + 1, lineText, heading, owners, reason });
        return;
      }
      if (!found.has(key)) {
        found.set(key, { file, line: idx + 1, lineText, heading,
          sectionText: lines.slice(sectionStart, sectionEnds.get(sectionStart)).join("\n") });
      }
    });
  }
  return { citations: found, indexRejections, ownershipRejections };
}

/** Always emitted by trim CLIs, including when the stricter ownership gate rejects nothing. */
export function printOwnershipRejections(rejections: OwnershipRejection[]): void {
  console.log(`ownershipRejections: ${JSON.stringify(rejections)}`);
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
  // poller-brain#343 round 2 (DevGuru catch): a MEM-N token surviving
  // stripMemCitations means it wasn't in a safely-strippable leading/
  // trailing tag position (e.g. embedded mid-sentence: "Halt logic
  // (mirrors MEM-47)", "Why MEM-213 was retracted") — such a token would
  // become a citation to that key once this hook is written into
  // LEARNINGS.md as a pointer, corrupting the distinct-key invariant
  // regardless of whether the guard happens to catch it. Reject outright
  // rather than attempt a cosmetic repair that can only produce a worse
  // fragment.
  if (new RegExp(String.raw`\b${MEM_ID_PATTERN}\b`).test(s)) return false;
  return true;
}

/**
 * A single MEM-N citation token in a BALANCED wrapped form only:
 * `` `[MEM-257]` ``, `[MEM-172]`, `` `MEM-47` ``, or a compact cluster like
 * `[MEM-93/94/122]`. Deliberately excludes the bare, unwrapped form
 * (`MEM-213` with no backtick/bracket at all) — round 3 (DevGuru catch, live
 * measurement on his own brain's 96 real headings): independently-optional
 * wrapper characters let the leading/trailing anchors match an UNBALANCED
 * fragment, truncating real prose instead of removing a real tag:
 * `Pointer hygiene [see MEM-213]` → trailing match grabs bare `MEM-213]`
 * (the lone `]`, no matching `[`) → `Pointer hygiene [see`; `MEM-213:
 * descriptive title long enough` → leading match grabs bare `MEM-213` →
 * `: descriptive title long enough`; `Everything you need about MEM-213` →
 * trailing bare match → `Everything you need about`. All three pass
 * `isReliableHook` and would have shipped a truncated hook. Requiring a
 * matched wrapper pair (or none at all, i.e. not attempting the strip)
 * removes the bare form from the tag grammar entirely — a naked `MEM-213`
 * anywhere is never "tag position", so it always falls through to
 * `isReliableHook`'s embedded-MEM- rejection instead.
 */
const TAG_ID_SRC = `${MEM_CITATION_PATTERN}(?::obsolete)?`;
const TAG_TOKEN_SRC =
  "(?:`\\[" + TAG_ID_SRC + "\\]`|\\[" + TAG_ID_SRC + "\\]|`" + TAG_ID_SRC + "`)";
/** A run of one or more tag tokens (multi-key clusters like `[MEM-213][MEM-214]`), anchored to the START of the string. */
const LEADING_TAGS_RE = new RegExp(`^(?:${TAG_TOKEN_SRC}\\s*)+`);
/** Same, anchored to the END of the string. */
const TRAILING_TAGS_RE = new RegExp(`(?:\\s*${TAG_TOKEN_SRC})+$`);

/**
 * A line's leading citation tag(s), in "subject position" — immediately
 * after typical list/heading decoration (`- `, `## `, `**`) and before any
 * other content — if that leading run cites exactly one distinct key.
 * Returns null when the line has no leading tag, or when the leading run
 * cites 2+ distinct keys (`[MEM-93/94/122]`, or a RUN of separate tags like
 * `[MEM-167]/[MEM-170]/[MEM-171]` — several co-equal subjects, not one, so
 * it stays ambiguous exactly like today).
 *
 * poller-brain#334 (MEM-53): reuses the same `TAG_TOKEN_SRC` grammar
 * `extractHook`/`stripMemCitations` already trust for "this token is
 * decoration, not prose" (poller-brain#343), applied at the START of a
 * destination LINE instead of a heading.
 *
 * Captures a leading RUN of tags (`(?:${TAG_TOKEN_SRC}[\s/,·:;]*)+`), not
 * just the first one — DevGuru catch, review round 1: an earlier version
 * matched only the first tag, so a real leading run like
 * `[MEM-167]/[MEM-170]/[MEM-171]: the SNS target is ...` silently picked
 * MEM-167 as the sole subject instead of staying ambiguous (`LEADING_TAGS_RE`
 * two lines below already proves a leading run is a routine shape, not an
 * edge case — measured live: 4 real occurrences across 3 brains, one of
 * which demoted MEM-355 from its own dedicated heading to a shared
 * bookkeeping line). `distinctCitedKeysInLine` below still requires the
 * WHOLE captured run to name exactly one distinct key, so a genuine run of
 * co-equal tags correctly stays rejected — only a citation buried anywhere
 * else on the line (a trailing parenthetical, a compact cluster
 * mid-sentence, "per this rule (MEM-6/98/100)"-style justification prose)
 * never matches and never gains new evidence.
 */
const SUBJECT_TAG_RE = new RegExp(
  `^\\s*(?:[-*]\\s+)?(?:#{1,6}\\s+)?(?:\\*\\*)?((?:${TAG_TOKEN_SRC}[\\s/,·:;]*)+)`
);

function subjectPositionKey(line: string): string | null {
  const m = SUBJECT_TAG_RE.exec(line);
  if (!m) return null;
  const keys = distinctCitedKeysInLine(m[1]);
  return keys.length === 1 ? keys[0] : null;
}

/**
 * Strip a LEADING and/or TRAILING run of MEM-N citation tag(s) — own or
 * foreign — from a heading before it's reused as a hook (poller-brain#343:
 * destination headings routinely self-tag their own promoted key, e.g.
 * `## Title [MEM-213][MEM-214]` or `` ## Title `[MEM-257]` `` — and a token
 * left in place becomes a citation to that key once embedded in the new
 * LEARNINGS.md pointer, silently changing the document's distinct-key set
 * and tripping `verifyLearningsTrimStats`'s count-verify guard).
 *
 * Deliberately narrow (DevGuru catch, round 2): a tag at the very start or
 * end of the heading is unambiguous decoration — the WHOLE wrapped unit is
 * matched and removed together, so no empty backtick/bracket artifact is
 * left behind and no unrelated punctuation elsewhere in the string is
 * touched. A MEM-N token embedded mid-heading (running prose or a
 * parenthetical, e.g. `Halt logic (mirrors MEM-47)`) is NOT touched here —
 * cosmetically repairing that class only produces a worse fragment (`Halt
 * logic (mirrors)`). `isReliableHook` rejects any hook that still contains a
 * MEM-N reference after this pass (including a bare/unbalanced token this
 * function never attempts to strip — see `TAG_TOKEN_SRC`), routing the key
 * to `unreliableHooks` for manual review — the only two outcomes are
 * "cleanly stripped" or "excluded", never "mangled and shipped".
 */
function stripMemCitations(heading: string): string {
  return heading.replace(LEADING_TAGS_RE, "").replace(TRAILING_TAGS_RE, "").trim();
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
 *
 * Round 5 (poller-brain#343): the heading text is stripped of
 * leading/trailing `MEM-N` tag tokens first — see `stripMemCitations`. A
 * token that survives the strip (embedded mid-heading) makes
 * `isReliableHook` reject the result, same excluded-not-guessed path.
 */
export function extractHook(citation: Citation): string | null {
  if (citation.heading === null) return null;
  return stripMemCitations(citation.heading);
}

export function sortKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => compareMemIds(a, b));
}
