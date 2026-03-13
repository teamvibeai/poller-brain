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
| `scheduledAt` | for ONE_TIME | ISO 8601 datetime (e.g., `2026-03-15T09:00:00Z`) |
| `timezone` | no | IANA timezone (default: UTC). Use `Europe/Prague` for Czech users |
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
3. It runs in the channel's context, so `send_message` goes to the right place
4. Keep it specific — you won't have the original conversation context

**Good examples:**
- `"Check open PRs on GitHub and post a summary to this channel."`
- `"Send a message: 'Good morning! Time to review the dashboard.'"`
- `"Run the /invest:run skill and post results in a thread."`

**Bad examples:**
- `"Good morning!"` — This is a message, not an instruction. You'd interpret it as a greeting to yourself.
- `"Check PRs"` — Too vague. Which repo? What to do with results?

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
  "scheduledAt": "<current time + 30 min in ISO 8601>",
  "timezone": "Europe/Prague",
  "promptTemplate": "Send a reminder message: 'Hey, time to call John!'"
}
```

### Updating an existing schedule

User: "Change that PR check to 9am instead"

1. Call `list_scheduled_messages` to find the schedule ID
2. Call `create_scheduled_message` with the `scheduleId` and updated `cronExpression: "0 9 * * 1-5"`

## Timezone

- Default is UTC. Most Czech users want `Europe/Prague`.
- If the user doesn't specify, ask once and remember in MEMORY.md.
- Common timezones: `Europe/Prague`, `America/New_York`, `America/Los_Angeles`, `Asia/Tokyo`

## Common cron patterns

| Pattern | Expression |
|---------|-----------|
| Every weekday at 9am | `0 9 * * 1-5` |
| Every Monday at 9am | `0 9 * * 1` |
| Every hour | `0 * * * *` |
| Every day at midnight | `0 0 * * *` |
| Every 1st of month at 10am | `0 10 1 * *` |
