---
name: slack
description: |
  Slack communication tools for sending messages, reactions, reading threads, and uploading snippets.
  This skill is always active — use these MCP tools to respond to users in Slack.
---

# Slack Communication Skill

All Slack tools are available as MCP tools (prefixed `mcp__slack__`). Channel and thread defaults come from the session when available; sessions from other origins (such as email) may have neither.

`send_message` publishes immediately unless `dry_run: true` requests a wrapper preflight. `upload_snippet` and `upload_file` publish immediately, including an upload's `initial_comment`; they do not support `dry_run`. Never post placeholder/probe messages or uploads to discover or validate a destination.

For ordinary Slack replies, omit `thread_ts` to use the current thread. With no session thread context, `send_message` with an explicit `channel` and omitted `thread_ts` creates a channel-root post. Use `thread_ts: null` for a deliberate root post, including from a thread session. Upload tools require an explicit or current thread timestamp and do not support `thread_ts: null`.

## Finding a channel

1. For an unknown channel name, call `list_channels` first. It returns conversations this bot belongs to, excludes archived channels, and caps results at 200 by default (maximum `limit: 1000`). Absence from results does not mean absence from the workspace; the list may be incomplete or the bot may lack access. You can request a higher limit up to 1000, but must not treat capped results as exhaustive.
2. Confirm the selected ID with `read_channel_info` (`channel: "C…"`), checking its name, topic/purpose, and archive status before sending.
3. If the destination is missing, ambiguous, inaccessible, archived, or incompletely discovered, stop and report the unresolved destination to the human or via `submit_feedback`. Never guess a name or ID, choose a nearby channel, or send a probe.

If a stray post has already been published, use `delete_message(channel, ts)` to remove that exact message only when cleanup is intended. The tool verifies that the authenticated bot authored it and refuses uncertain ownership. If cleanup fails, report the channel ID, message timestamp and error to the human or via `submit_feedback`. Deletion does not retract notifications or undo sessions already started.

## Tools

### send_message — Send a message (primary response method)
- `text` (required): Message text with Slack markdown
- `channel`: Override channel (default: current)
- `thread_ts`: Override thread (default: current, if available); `null` for a deliberate channel-root post
- `dry_run`: Boolean, default `false`. With `true`, returns the effective `channel`, `thread_ts`, `mode` (`thread` or `root`), transformed initial `payload`, transformation echo and advisory validation limits. Makes no API calls or writes: no post/update, uploads, modal registration or session creation.

Preflight uses the same table auto-conversion, bold-URL repairs and text/block assembly as publication. Modal definitions are returned as a deferred plan; generated button IDs and the subsequent update require real registration and are not part of the initial payload. The preview resolves arguments/session defaults, not channel names, access, archive state or thread existence. Full Block Kit/modal validation and post-send warnings are not evaluated; later delivery can still fail. Preflight does not replace read-only destination discovery or authorize publication.

### delete_message — Delete one message authored by this bot
- `channel` (required): Explicit Slack conversation ID; no session default
- `ts` (required): Exact message timestamp, including six fractional digits

Checks fresh `auth.test` bot/user identity against the exact message from `conversations.history` or `conversations.replies`. Every present `user`/`bot_id` must match. Unknown, conflicting, unreadable or incomplete ownership fails closed; caller ownership assertions, credentials and recursive deletion flags are rejected. Deletes only the named message, including when it has replies.

Tool failures set MCP `isError` and return `ok: false` with stable `error`: `not_found`, `permission_denied`, `ownership_unverified`, or `delete_failed` (the last includes uncertain delete outcomes; read the message again before deciding to retry). Each validated attempt emits one JSON stderr audit line with event `slack.delete_message`, destination, verified actor IDs when available, outcome and any Slack error code; it omits credentials and message content.

Required permissions: [`chat:write`](https://docs.slack.dev/reference/methods/chat.delete/) plus the applicable [`channels:history`, `groups:history`, `im:history`, or `mpim:history`](https://docs.slack.dev/reference/methods/conversations.history/) for ownership reads. [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/) requires no additional scope. Thread lookup can be restricted by conversation/token type; never substitute broader credentials when it fails. Before rollout, the platform owner must confirm installed scopes, audit capture and handling of Slack [`message_deleted`](https://docs.slack.dev/reference/events/message/message_deleted/) events; this wrapper does not implement the platform event consumer.

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

Returns messages with `user`, `text`, `ts`, `is_bot`, `blocks` (raw Block Kit array if present), `attachments` (legacy attachments if present), `files` (metadata + `url`; fetch content via `download_file`).

### read_channel — Read channel history
- `limit`: Max messages (default: 20)
- `channel`: Override channel

Returns messages with `user`, `text`, `ts`, `is_bot`, `thread_ts`, `reply_count`, `blocks`, `attachments`, `files` (same shape as `read_thread`).

### upload_snippet — Upload code/text snippet
- `title` (required): Snippet title
- `content` (required): Snippet content
- `filetype`: File type (default: `text`). Common: `javascript`, `python`, `json`, `markdown`, `csv`
- `channel`: Override channel
- `thread_ts`: Override thread (default: current; required explicitly without session thread context)

Use for sharing code blocks, logs, or long text instead of pasting into a message.

### download_file — Download Slack files
- `url` (required): Slack file URL (`url_private` from file objects in messages)

Returns file content as text.

### upload_file — Upload local files
- `filepath` (required): Absolute path to the local file
- `title`: File title (default: filename)
- `channel`: Override channel
- `thread_ts`: Override thread (default: current; required explicitly without session thread context)

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

Use when the user needs **sort, filter, or pagination** over structured data, or when the dataset is too large for a comfortable inline GFM table. Required fields: `caption` (string), `rows` (array). Optional: `page_size` (1–100, default 5), `row_header_column_index` (default 0).

**Cell types:**
- `raw_text` — fields: `type`, `text` (string).
- `raw_number` — fields: `type`, `value` (number, used for numeric sort), `text` (string, the displayed label). **Both `value` and `text` are required** — sending `raw_number` with only one is rejected by Slack as `invalid_blocks` (verified empirically against `chat.postMessage` 2026-05-27).
- `rich_text` — header cells only; standard rich_text block structure (sections, lists, links, mentions).

Constraints: 2–101 rows, 1–20 columns, 10,000-character total across all cells.

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
          { "type": "raw_number", "value": 47, "text": "47" }
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
