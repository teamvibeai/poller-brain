# Memory script dependencies

Before running the trim scripts from a fresh checkout or after a dependency
update, install their locked JavaScript dependencies:

```sh
npm ci --prefix "$CLAUDE_CONFIG_DIR/skills/memory" --ignore-scripts
```

For a repository checkout, use `--prefix skills/memory`. CI performs the same
install before running the MEM suites, including `citation-detect.test.ts`.
There are no native dependencies or install scripts.

`citation-detect.ts` uses `mdast-util-from-markdown` 2.0.2, backed by micromark,
for CommonMark block and inline parsing. The repo had no existing Markdown
parser. mdast supplies both heading nodes and source positions, including the
entire multiline Setext title; this avoids a second lexer or token-to-AST
adapter. Only heading nodes establish sections. Code and HTML are excluded
from evidence. Inline code stays literal inline text (including the existing
backtick-wrapped MEM tags inside real headings); it never becomes a heading.

The independent raw-source guard from #447 fix2 remains deliberately
conservative: a foreign raw MEM heading anywhere in the AST section vetoes
the whole section as `uncertain-section`, even inside hidden content. Raw
heading shapes also cap evidence after hidden generic or same-key boundaries.
This guard does not determine Markdown structure.

The regression matrices keep every prior fixture. CommonMark corrects three
old lexer expectations: exiting a quote ends its fence, indented code cannot
supply registry coverage, and a real Setext heading owns its section (so a
foreign citation there reports `foreign-key`). The new parser suite covers
the review3 fixtures through proposal/apply, full Setext spans, container exits,
HTML blocks, and the independent raw veto.
