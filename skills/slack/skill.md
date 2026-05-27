---
name: slack
description: |
  Slack communication tools for sending messages, reactions, reading threads, and uploading snippets.
  This skill is always active — use these MCP tools to respond to users in Slack.
---

# Slack Communication Skill

All Slack tools are available as MCP tools (prefixed `mcp__slack__`). Channel and thread context are automatically configured.

## Tools

### send_message — Send a message (primary response method)
- `text` (required): Message text with Slack markdown
- `channel`: Override channel (default: current)
- `thread_ts`: Override thread (default: current)

### add_reaction — Add emoji reaction
- `name` (required): Emoji name without colons (e.g., `eyes`, `white_check_mark`)
- `channel`: Override channel
- `timestamp`: Override message (default: original message)

Gracefully handles `already_reacted`.

### remove_reaction — Remove emoji reaction
- `name` (required): Emoji name without colons
- `channel`: Override channel
- `timestamp`: Override message (default: original message)

Gracefully handles `no_reaction`.

### read_thread — Read thread history
- `limit`: Max messages (default: 20)
- `channel`: Override channel
- `thread_ts`: Override thread

Returns messages with `user`, `text`, `ts`, `is_bot`, and `files` (if any).

### read_channel — Read channel history
- `limit`: Max messages (default: 20)
- `channel`: Override channel

Returns messages with `user`, `text`, `ts`, `is_bot`, `thread_ts`, `reply_count`.

### upload_snippet — Upload code/text snippet
- `title` (required): Snippet title
- `content` (required): Snippet content
- `filetype`: File type (default: `text`). Common: `javascript`, `python`, `json`, `markdown`, `csv`

Use for sharing code blocks, logs, or long text instead of pasting into a message.

### download_file — Download Slack files
- `url` (required): Slack file URL (`url_private` from file objects in messages)

Returns file content as text.

### upload_file — Upload local files
- `filepath` (required): Absolute path to the local file
- `title`: File title (default: filename)
- `channel`: Override channel
- `thread_ts`: Override thread

### set_status — Set typing indicator
- `text` (required): Status text (e.g., "Searching..."). Empty string clears.
- `channel`: Override channel
- `thread_ts`: Override thread

## Formatting

For plain text in the `text` field, Slack uses a custom markdown dialect:
- `*bold*`, `_italic_`, `~strikethrough~`
- `` `inline code` ``, ` ```code block``` `
- `>` for blockquotes
- `<@U123>` for user mentions

For richer content (GFM tables, headers, task lists, nested lists), use a `markdown` block — see *Message content blocks* below.

### Pitfalls

- **Tilde (`~`) means strikethrough** — Slack treats `~text~` as ~~strikethrough~~. If you use `~` for "approximately" (e.g., `~$330`), Slack may match it with another `~` later and strike through everything in between. Use `≈` or `cca` instead. Backtick-wrapping (`` `~$330` ``) also works but changes the visual style.
- **Pipe-delimited tables in `text` do NOT render** — `| col1 | col2 |\n|------|------|` in the `text` field displays as literal plain text. Either move the content into a `markdown` block (which renders GFM tables visually) or use a `data_table` block for interactive datasets (see *Message content blocks*).

## Message content blocks

Pass an array of blocks via the `blocks` parameter of `send_message`. When `blocks` is present, the `text` field is auto-prepended as a section block by the MCP tool (so it stays visible AND serves as the notification fallback).

Two blocks cover ~99% of agent use cases — prefer them by default:

### `markdown` block — default for rich text and small tables

Use for any LLM-generated response with formatting (per Slack docs: *"when you expect a markdown response from an LLM that can get lost in translation rendering in Slack"*). Supports GFM: headers, bold/italic/strikethrough, ordered/unordered/task lists, code blocks with syntax highlighting, links, blockquotes, horizontal rules, and **GFM pipe tables** rendered as visually aligned tables. Cumulative 12,000-character limit per payload.

```json
{
  "text": "Tickets summary",
  "blocks": [
    {
      "type": "markdown",
      "text": "## Open tickets\n\n| ID | Status | Owner |\n|----|--------|-------|\n| [#123](https://example.com/123) | open | @alice |\n| [#124](https://example.com/124) | wip  | @bob   |\n\n_Updated 2 min ago._"
    }
  ]
}
```

Reference: [markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block).

### `data_table` block — large or interactive datasets

Use when the user needs **sort, filter, or pagination** over structured data, or when the dataset is too large for a comfortable inline GFM table. Required fields: `caption` (string), `rows` (array). Optional: `page_size` (1–100, default 5), `row_header_column_index` (default 0). Cell types: `raw_text` (string), `raw_number` (numeric, enables numeric sort), `rich_text` (header cells only). Constraints: 2–101 rows, 1–20 columns, 10,000-character total across all cells.

```json
{
  "text": "Last 30 days of incidents",
  "blocks": [
    {
      "type": "data_table",
      "caption": "Last 30 days of incidents",
      "page_size": 10,
      "rows": [
        [
          { "type": "raw_text", "text": "ID" },
          { "type": "raw_text", "text": "Severity" },
          { "type": "raw_text", "text": "Duration (min)" }
        ],
        [
          { "type": "raw_text", "text": "INC-742" },
          { "type": "raw_text", "text": "P1" },
          { "type": "raw_number", "value": 47 }
        ]
      ]
    }
  ]
}
```

Reference: [data_table block](https://docs.slack.dev/reference/block-kit/blocks/data-table-block).

### Other useful blocks (short reference)

| Block | Purpose | Docs |
|-------|---------|------|
| `header` | Big bold heading (plain_text only, ≤150 chars) | [header](https://docs.slack.dev/reference/block-kit/blocks/header-block) |
| `divider` | Horizontal rule separator | [divider](https://docs.slack.dev/reference/block-kit/blocks/divider-block) |
| `section` | Text + optional accessory (button, image, select) | [section](https://docs.slack.dev/reference/block-kit/blocks/section-block) |
| `rich_text` | Hand-built rich text (preformatted, lists, quotes) — usually `markdown` block is simpler | [rich_text](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block) |
| `actions` | Row of interactive elements (buttons, selects, datepickers) | [actions](https://docs.slack.dev/reference/block-kit/blocks/actions-block) |
| `context` | Small supplementary text + thumbnails (timestamps, footers) | [context](https://docs.slack.dev/reference/block-kit/blocks/context-block) |
| `image` | Inline image with optional title | [image](https://docs.slack.dev/reference/block-kit/blocks/image-block) |
| `input` | Form field (modals only) | [input](https://docs.slack.dev/reference/block-kit/blocks/input-block) |
| `file` | Render an uploaded file inline | [file](https://docs.slack.dev/reference/block-kit/blocks/file-block) |
| `video` | Embedded video player | [video](https://docs.slack.dev/reference/block-kit/blocks/video-block) |

Full catalog of 19 block types: [Block Kit — blocks reference](https://docs.slack.dev/reference/block-kit/blocks).

### Large datasets / export scenarios

For exports or datasets that don't fit interactive constraints (≥101 rows, ≥20 columns, ≥10k chars), use `upload_snippet` with `filetype: "csv"` or `upload_file` for XLSX. Keeps the channel readable and lets the user open it in their spreadsheet tool.
