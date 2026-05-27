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

Use Slack markdown in messages:
- `*bold*`, `_italic_`, `~strikethrough~`
- `` `inline code` ``, ` ```code block``` `
- `>` for blockquotes
- `<@U123>` for user mentions

### Pitfalls

- **Tilde (`~`) means strikethrough** — Slack treats `~text~` as ~~strikethrough~~. If you use `~` for "approximately" (e.g., `~$330`), Slack may match it with another `~` later and strike through everything in between. Use `≈` or `cca` instead. Backtick-wrapping (`` `~$330` ``) also works but changes the visual style.
- **Markdown tables do NOT render** — pipe-delimited tables (`| col1 | col2 |\n|------|------|`) are displayed as literal plain text in Slack. Columns won't align, separators stay visible, the result is unreadable. Use Block Kit `table` block instead (see *Tabular data* below).

## Tabular data

When presenting structured/tabular data, **default to Block Kit `table` block** (available since Aug 2025) passed via the `blocks` parameter of `send_message`. Markdown tables in `text` do not render (see *Pitfalls*).

**Block Kit `table` block** — rows of `rich_text` cells. Supports clickable links, column alignment, text wrapping, and bold/italic styling inside cells. Reference: [Slack Block Kit — table block](https://api.slack.com/reference/block-kit/blocks#table).

Minimal shape:

```json
{
  "text": "Tickets summary",
  "blocks": [
    {
      "type": "table",
      "rows": [
        [
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "ID", "style": { "bold": true } }] }] },
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "Status", "style": { "bold": true } }] }] }
        ],
        [
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "link", "url": "https://example.com/123", "text": "#123" }] }] },
          { "type": "rich_text", "elements": [{ "type": "rich_text_section", "elements": [{ "type": "text", "text": "open" }] }] }
        ]
      ]
    }
  ]
}
```

The `text` field is auto-prepended as a section block by `send_message` (keeps the table preceded by a caption and works as a notification fallback).

**Large datasets / export scenarios** — use `upload_snippet` with `filetype: "csv"` (or `upload_file` for XLSX). Rough threshold: more than ~10 rows or ~5 columns is better as a downloadable snippet than an inline table — keeps the channel readable and lets the user open it in their spreadsheet tool of choice.
