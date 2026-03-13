---
name: teamvibe-api
description: |
  TeamVibe API tools for managing scheduled messages (reminders, recurring tasks, one-time triggers).
  This skill is always active — use these MCP tools when users ask to schedule, remind, or automate.
---

# TeamVibe API — Scheduled Messages

All tools are prefixed `mcp__teamvibe-api__`. Channel and workspace context are automatically set.

## Tools

### create_scheduled_message

Create or update a schedule.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `promptTemplate` | **yes** | Instruction to yourself — what to do when the schedule fires (see below) |
| `scheduleType` | no | `CRON` (recurring, default) or `ONE_TIME` |
| `cronExpression` | for CRON | Standard cron (e.g., `0 9 * * 1-5` = weekdays 9am) |
| `scheduledAt` | for ONE_TIME | ISO 8601 datetime **in UTC** (e.g., `2026-03-15T09:00:00Z`). Must include `Z` suffix. |
| `timezone` | for CRON only | IANA timezone for cron evaluation (default: UTC). **Ignored for ONE_TIME.** |
| `endDate` | no | Optional end date for recurring schedules |
| `scheduleId` | no | Pass existing ID to update a schedule |
| `status` | no | `ACTIVE` (default) or `PAUSED` |

### list_scheduled_messages

List all schedules for the current channel. No required parameters.

### delete_scheduled_message

| Parameter | Required | Description |
|-----------|----------|-------------|
| `scheduleId` | **yes** | ID of the schedule to delete |

## Writing promptTemplate

The `promptTemplate` is **an instruction to yourself** (Claude), not the message text. When the schedule fires, you receive this prompt in a new session with no thread context.

**Rules:**
1. Write it as a clear instruction: what to do, what to send, where
2. The scheduled session has access to all your tools (Slack, web, files)
3. `send_message` defaults to the **channel root**, NOT to any thread. To reply in a specific thread, hardcode `thread_ts` in the prompt: `"Post in thread 1741234567.890123: ..."`
4. Keep it specific — you won't have the original conversation context
5. Include everything the session needs: `thread_ts`, user IDs to `@mention`, relevant data (ticket numbers, amounts, etc.) — nothing will be inferred from the original conversation

**Good examples:**
- `"Check open PRs on GitHub and post a summary to this channel."`
- `"Send a message: 'Good morning! Time to review the dashboard.'"`
- `"Post in thread 1741234567.890123: 'Reminder: please review the proposal above.'"` — hardcoded thread_ts for thread reply
- `"Send a message mentioning <@U1234ABCD>: 'Hey, your deploy is done!'"`

**Bad examples:**
- `"Good morning!"` — This is a message, not an instruction. You'd interpret it as a greeting to yourself.
- `"Check PRs"` — Too vague. Which repo? What to do with results?
- `"Reply to the thread with a reminder"` — No thread_ts specified; the session has no thread context, so this will post to channel root.

## Examples

### Recurring (CRON)

User: "Every weekday at 8am, check PRs"

```json
{
  "scheduleType": "CRON",
  "cronExpression": "0 8 * * 1-5",
  "timezone": "Europe/Prague",
  "promptTemplate": "Check open pull requests on GitHub. Post a summary to this channel listing PRs that need review, with links."
}
```

### One-time (ONE_TIME)

User: "In 30 minutes, remind me to call John"

```json
{
  "scheduleType": "ONE_TIME",
  "scheduledAt": "<current time + 30 min in UTC, with Z suffix>",
  "promptTemplate": "Send a reminder message: 'Hey, time to call John!'"
}
```

**Important:** `scheduledAt` must always be in UTC. If the user says "at 10:00 Prague time" (CET = UTC+1), convert it: `scheduledAt: "2026-03-15T09:00:00Z"`. Do NOT pass `timezone` for ONE_TIME — it is ignored.

### Updating an existing schedule

User: "Change that PR check to 9am instead"

1. Call `list_scheduled_messages` to find the schedule ID
2. Call `create_scheduled_message` with the `scheduleId` and updated `cronExpression: "0 9 * * 1-5"`

## Timezone

- **CRON:** `timezone` controls when the cron expression fires. Default is UTC. Most Czech users want `Europe/Prague`.
- **ONE_TIME:** `timezone` is **not used**. `scheduledAt` must be UTC (with `Z` suffix). Convert local times to UTC before sending.
- If the user doesn't specify their timezone for CRON schedules, ask once and remember in MEMORY.md.
- Common timezones: `Europe/Prague`, `America/New_York`, `America/Los_Angeles`, `Asia/Tokyo`

## Common cron patterns

| Pattern | Expression |
|---------|-----------|
| Every weekday at 9am | `0 9 * * 1-5` |
| Every Monday at 9am | `0 9 * * 1` |
| Every hour | `0 * * * *` |
| Every day at midnight | `0 0 * * *` |
| Every 1st of month at 10am | `0 10 1 * *` |
