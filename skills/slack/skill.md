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
