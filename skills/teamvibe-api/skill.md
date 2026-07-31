---
name: teamvibe-api
description: |
  TeamVibe API tools for managing scheduled messages (reminders, recurring tasks, one-time triggers)
  and submitting agent feedback (bugs, improvements, observations).
  This skill is always active — use these MCP tools when users ask to schedule, remind, or automate.
---

# TeamVibe API — Scheduled Messages & Feedback

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
| `origin` | no | *Delivery target* (`channel`, `thread_ts`, `source`) for the scheduled runs. Auto-inherits **this session's** channel if omitted, and is **frozen** at create time — see the warning below. |

> ⚠️ **Delivery target is frozen from the creating session.** If you omit `origin`, the schedule's delivery channel is captured from **the Slack channel you are in right now** and replayed on every run. Create a schedule from a **DM** (or any channel that isn't the intended recipient) and every run is delivered *there*, not where you meant. This caused a real misdelivery — a reminder went to the wrong person's DM ([poller-brain#124](https://github.com/teamvibeai/poller-brain/issues/124)).
>
> **Rule:** when the schedule is meant for a **different channel/recipient than your current session**, pass `origin` explicitly:
> ```json
> {
>   "scheduleType": "ONE_TIME",
>   "scheduledAt": "2026-03-15T09:00:00Z",
>   "promptTemplate": "Post: 'Reminder: ...'",
>   "origin": { "source": "slack", "channel": "C0PROJECT123" }
> }
> ```
> The `create_scheduled_message` response echoes a `delivery` block with the resolved `channel` and a `resolvedFrom` flag (`inherited-from-current-session` vs `explicit-origin`) — **verify it matches the intended recipient** before trusting the schedule.

### list_scheduled_messages

List all schedules for the current channel. No required parameters.

Every run timestamp comes back twice: the stored ISO-UTC value (`lastRunAt`, `nextRunAt`, `scheduledAt`) and a rendered `*Local` twin in the schedule's own timezone with the weekday — `"lastRunAtLocal": "Thu 2026-05-28 18:00:17 (Europe/Prague)"`. Read the `*Local` field. See [Verifying a schedule](#verifying-a-schedule).

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

## Best Practices

### Data-before-reference rule

Never send a message referencing an output (file, URL, generated data) before that output exists. If the session crashes between the message and data generation, the user gets broken references.

**Valid pattern:**
```
1. send_message("Generating report...")         ← no output references
2. Generate data, write files, fetch results
3. send_message in thread with results + links  ← outputs exist
```

**Invalid pattern:**
```
1. send_message("Here's your report: <link>")   ← link references non-existent output
2. Generate the report                           ← session crash = broken link
```

Informational messages (status updates, "starting..." notifications) can be sent at any time since they don't reference outputs.

### Step ordering in promptTemplate

When your `promptTemplate` involves multiple steps, order them defensively:
1. **Gather data first** — fetch, compute, generate
2. **Validate results** — check for errors or empty responses
3. **Send message last** — only after you have confirmed output to share

### Partial failure handling

If a scheduled task partially fails (e.g., data fetch works but formatting breaks):
- Send what you have with a note about what failed
- Log the failure to TODAY.md for traceability
- Don't silently fail — a partial result is better than no response

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

## Verifying a schedule

Before concluding that a schedule misfired — and **always** before filing a bug about one — check it against the rendered timestamps rather than your own arithmetic.

**Never assert a weekday from a date without computing it.** This is not a style rule; it is the failure that produced [#145](https://github.com/teamvibeai/poller-brain/issues/145). A schedule on `0 18 * * 1-4` (Mon–Thu) was reported as having skipped Thursday `2026-05-29`. That date was a **Friday**, the Thursday run had happened normally, and the resulting bug report against the scheduler cost a full diagnosis cycle. The stored row said everything needed to refute it — but only in UTC, so the check was never made.

The routine:

1. Read `lastRunAtLocal` and `nextRunAtLocal`, not `lastRunAt` / `nextRunAt`. They carry the weekday and the schedule's own timezone.
2. Confirm both weekdays are allowed by the day-of-week field of `cronExpression`. If the last run and the next run both sit inside the pattern, nothing was skipped — a gap over excluded days is the schedule working.
3. Remember what `lastRunAt` actually means: the run was **enqueued** at that moment, not necessarily delivered. It is evidence the scheduler fired, not evidence you received anything.
4. If you still believe a run was missed, say what you checked and what remains unexplained. "`nextRunAt` jumped from Thu to Mon and `1-4` includes Thursday" is a claim; "Thursday's run is absent from `lastRunAtLocal` although the previous and following occurrences both landed" is evidence.

After `create_scheduled_message`, the response echoes the stored row with `nextRunAtLocal` — one glance confirms the cron means what you intended before you walk away from it.

## Common cron patterns

| Pattern | Expression |
|---------|-----------|
| Every weekday at 9am | `0 9 * * 1-5` |
| Every Monday at 9am | `0 9 * * 1` |
| Every hour | `0 * * * *` |
| Every day at midnight | `0 0 * * *` |
| Every 1st of month at 10am | `0 10 1 * *` |

---

# Agent Feedback

## submit_feedback

Submit feedback about the platform. Stored in a central database and consolidated by the eval pipeline.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `type` | **yes** | `bug`, `improvement`, or `observation` |
| `priority` | **yes** | `low`, `medium`, `high`, or `critical` |
| `context` | **yes** | Description of the feedback (min 10 chars) |

### When to use

- Default route for platform feedback: general bug/improvement/observation
  signals, including "report this" / "zapiš jako issue" when the user hasn't
  asked for a dedicated numbered issue right away
- You observe a platform problem worth tracking (repeated MCP failures,
  missing features)
- You want to suggest an improvement based on your experience

Note: if the user explicitly wants a dedicated numbered GitHub issue tracked
immediately (not batched into a weekly digest), use `PENDING_ISSUES.md`
instead — see CLAUDE.md's Reporting Issues section.

### Example

```json
{
  "type": "bug",
  "priority": "high",
  "context": "MCP fetch_failed errors occur 2-3x per session when calling read_thread. Retrying works but adds latency."
}
```
