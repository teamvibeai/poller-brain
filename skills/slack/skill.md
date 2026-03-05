---
name: slack
description: |
  Slack communication tools for sending messages, reactions, reading threads, and uploading snippets.
  This skill is always active — use these scripts to respond to users in Slack.
---

# Slack Communication Skill

All scripts are in `$SLACK_SCRIPTS_DIR`. Channel and thread context are provided via environment variables (`SLACK_CHANNEL`, `SLACK_THREAD_TS`, `SLACK_MESSAGE_TS`).

## Scripts

### send-message.ts — Send a message (primary response method)

```bash
npx tsx $SLACK_SCRIPTS_DIR/send-message.ts "Your message here"
```

Parameters:
- **positional** (required): Message text
- `--text "msg"`: Alternative way to pass message text
- `--channel C123`: Override channel (default: `$SLACK_CHANNEL`)
- `--thread_ts 123.456`: Override thread (default: `$SLACK_THREAD_TS`)

### add-reaction.ts — Add emoji reaction

```bash
npx tsx $SLACK_SCRIPTS_DIR/add-reaction.ts emoji_name
```

Parameters:
- **positional** (required): Emoji name without colons (e.g., `eyes`, `white_check_mark`)
- `--channel C123`: Override channel
- `--message_ts 123.456`: Override message timestamp (default: `$SLACK_MESSAGE_TS`)

### remove-reaction.ts — Remove emoji reaction

```bash
npx tsx $SLACK_SCRIPTS_DIR/remove-reaction.ts emoji_name
```

Same parameters as add-reaction.

### read-thread.ts — Read thread history

```bash
npx tsx $SLACK_SCRIPTS_DIR/read-thread.ts [limit]
```

Parameters:
- **positional** (optional): Max messages to return (default: 20)
- `--channel C123`: Override channel
- `--thread_ts 123.456`: Override thread

Returns JSON with `messages` array containing `user`, `text`, `ts`, `is_bot` fields.

### set-status.ts — Set typing indicator

```bash
npx tsx $SLACK_SCRIPTS_DIR/set-status.ts "Thinking..."
```

Parameters:
- **positional** (required): Status text (empty string clears status)

### upload-snippet.ts — Upload code/text snippet

```bash
npx tsx $SLACK_SCRIPTS_DIR/upload-snippet.ts "title" "content" [filetype]
```

Parameters:
- **positional 1** (required): Snippet title
- **positional 2** (required): Snippet content
- **positional 3** (optional): File type (default: `text`). Common: `javascript`, `python`, `json`, `markdown`

Use this for sharing code blocks, logs, or long text instead of pasting into a message.

## Output Format

All scripts output JSON:
- Success: `{"ok": true, ...data}`
- Failure: `{"ok": false, "error": "message"}`

## Formatting

Use Slack markdown in messages:
- `*bold*`, `_italic_`, `~strikethrough~`
- `` `inline code` ``, ` ```code block``` `
- `>` for blockquotes
- `<@U123>` for user mentions
