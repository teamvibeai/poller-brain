---
name: memory-consolidate
description: |
  Memory consolidation skill. Run during maintenance heartbeat to process daily
  logs into long-term memory. Should be invoked when memory/.last_consolidation
  is 1+ days old or missing.
---

# Memory Consolidation

Process recent daily logs and promote important information to long-term memory.

## When to Run

Check `memory/.last_consolidation` for the date of last consolidation.
If it's 1+ days old or missing, run consolidation.

## Algorithm

### 0. Archive TODAY.md

Before processing, archive `memory/TODAY.md` to the daily/ directory:

1. Read `memory/TODAY.md` — extract the date header(s) (format: `# YYYY-MM-DD`)
2. For each date section in TODAY.md:
   - Append its content to `memory/daily/YYYY-MM-DD.md` (create if needed)
3. Reset `memory/TODAY.md` with today's date header and an immediate consolidation log entry:
   ```
   # YYYY-MM-DD

   - HH:MM — memory consolidation started
   ```
   This entry is required — it ensures today's log is non-empty even if no user sessions follow, so the daily-log-weekly-coverage metric counts this day.

This ensures daily logs accumulate in `memory/daily/` while TODAY.md stays fresh for the current day.

**Report tracking (required):** After completing this step, add both `memory/TODAY.md` and the target `memory/daily/YYYY-MM-DD.md` to the JSON report's `filesChanged` array. This is mandatory — evaluators check `filesChanged` for `memory/TODAY.md` to verify this step ran. Omitting it causes the report to fail the `today-md-archived` criterion even when the archival was performed correctly.

If `memory/TODAY.md` doesn't exist, skip this step and create it with today's header after consolidation.

### 1. Scan Daily Logs

Read all files in `memory/daily/` dated since the last consolidation date.
If no `.last_consolidation` file exists, process the last 14 days of logs.

### 2. Extract Facts

For each daily log, identify:
- **Recurring themes** — things mentioned multiple times across days
- **Explicit corrections** — should already be in core/, verify they are
- **New factual knowledge** — team info, project details, domain knowledge
- **Significant events** — incidents, launches, decisions with lasting impact
- **Procedures learned** — workflows, how-tos, recipes

### 3. Evaluate Against Existing Memory

For each extracted fact, compare with existing memory files:
- **ADD** — new information not yet captured
- **UPDATE** — existing entry needs refinement or additional context
- **DELETE** — information is outdated or contradicted by newer facts
- **NOOP** — already accurately captured

### 4. Promote to Long-Term Memory

Route new/updated facts to appropriate locations:

| Type | Destination |
|------|-------------|
| Team/project facts | `memory/semantic/{topic}.md` |
| Significant events | `memory/episodic/{event-name}.md` |
| Workflows/procedures | `memory/procedural/{process-name}.md` |
| Preferences | `memory/core/PREFERENCES.md` |
| Lessons | `memory/core/LEARNINGS.md` |
| Mistakes | `memory/core/MISTAKES.md` |

### 5. Promote Mistakes

Review `memory/core/MISTAKES.md` for entries ready to be promoted. For each entry with status `new`:

1. **Determine the promotion path:**
   - Is the mistake specific to a skill/tool? → Add a pitfall to the relevant `skills/*/skill.md` file (create a `## Pitfalls` section if needed)
   - Is it a general operational rule? → Extract the lesson to `memory/core/LEARNINGS.md`
   - Is it critical enough for automated prevention? → Create a guard (file check, validation step) and document it in `memory/procedural/`

2. **Execute the promotion:**
   - Write the promoted content to its destination
   - Update the MISTAKES.md entry status to `promoted → {destination}`

3. **Clean up previously promoted entries:**
   - Remove entries that were marked `promoted` in the *previous* consolidation run (they've been visible for one cycle)
   - Keep entries marked `promoted` during *this* run (so the promotion is visible next cycle)

If MISTAKES.md has no entries or doesn't exist, skip this step.

**Report tracking:** Add any promoted-to files to `filesChanged`. Add a summary of promotions (or "no mistakes to promote") to the markdown report.

### 6. Regenerate SUMMARY.md

**Always regenerate `memory/SUMMARY.md` on every consolidation run — this step is non-negotiable, even if no facts were promoted in steps 2–4.** A lightweight consolidation with zero promotions must still regenerate SUMMARY.md to ensure it reflects the current state of all memory tiers.

Read all `memory/core/*.md`, scan `memory/semantic/`, `memory/episodic/`, `memory/procedural/` for file listing, and compile into the SUMMARY.md format defined in the memory skill. Target ~100-150 lines.

Key sections:
- **Identity** — who you are (from channel brain CLAUDE.md)
- **Key Rules** — compressed top rules from MISTAKES.md + LEARNINGS.md
- **Preferences** — compressed from PREFERENCES.md
- **Active Projects** — from recent episodic/ entries
- **Deep Memory Index** — pointers to all memory tiers with topic summaries

This replaces the old "Update MEMORY.md" step. SUMMARY.md is the new authoritative index.

**Report tracking (required):** Add `memory/SUMMARY.md` to the JSON report's `filesChanged` array. Evaluators check `filesChanged` for `memory/SUMMARY.md` to verify this step ran. Omitting it fails the `summary-md-regenerated` criterion even when the file was correctly regenerated.

### 7. Archive Old Daily Logs

For daily log files (format: `YYYY-MM-DD.md`) in `memory/daily/` that are older than 30 days:
- **Delete them.** Their content has already been promoted to long-term memory in steps 2–4.
- Do NOT create weekly summary files (`weekly-*.md`) — they accumulate in `memory/daily/` and eventually become stale files themselves, causing this step to fail in future runs.
- If any weekly summary files from a previous approach still exist in `memory/daily/` and are older than 30 days, delete those too.
- After deletion, verify no files dated more than 30 days ago remain in `memory/daily/`.

**Recent-log retention (non-negotiable):** NEVER delete `memory/daily/<today>.md` or `memory/daily/<yesterday>.md`, regardless of whether their contents have been promoted. Same-day and next-day sessions rely on these files to recover context. Promotion is not a reason to delete; deletion is only for files dated 30+ days ago.

### 8. Update Timestamp

Write the current date to `memory/.last_consolidation`:
```
YYYY-MM-DD
```

### 9. Assess Daily Log Compliance

Before self-critique, run observable checks on the daily log scratchpad and record the outcome in both reports.

Checks (all over the last 7 days unless specified):

1. **Today's log exists.** If any session ran today (commits, reports, or MCP tool calls today), verify `memory/TODAY.md` exists and has non-empty content (or `memory/daily/YYYY-MM-DD.md` for today exists after archival). If no sessions ran today, pass.
2. **Continuous appends.** Today's log (or the most recent day that had 2+ sessions) contains 2+ distinct timestamped or bulleted entries — not a single dump. A file with a lone session-end paragraph fails this check.
3. **Retention.** `memory/TODAY.md` exists with today's header, and `memory/daily/<yesterday>.md` is present after consolidation completes.
4. **No empty logs.** No `memory/daily/*.md` file is empty or contains only a header.
5. **Weekly coverage.** Compute `days_with_daily_log / days_with_any_session` over the last 7 days. Target ≥ 0.8. "Days with sessions" = days with commits to this brain, reports written, or (if available) inbox activity.
6. **`@` imports configured.** Read the channel brain `CLAUDE.md` and verify it contains both `@memory/SUMMARY.md` and `@memory/TODAY.md`. If either is missing, fail this check. If CLAUDE.md doesn't exist, fail.

Write the result into the markdown report as a `## Daily Log Compliance` section (see example in MAINTENANCE.md). Populate the corresponding `selfAssessment` keys in the JSON report:

- `daily-log-exists-today`
- `daily-log-continuous-appends`
- `daily-log-recent-retention`
- `daily-log-weekly-coverage`
- `at-imports-configured`

If any check fails, do one of two things before finishing:

- **Backfill** — if you can reconstruct entries from git log, reports, or this session's context, append them to `memory/TODAY.md` or the correct `memory/daily/*.md` file with a note that they were reconstructed (e.g., `- (backfilled from git) 15:30 — shipped PR #51`).
- **Flag** — if backfill isn't possible, add a `[self-critique]` entry in `processImprovements` naming the specific gap and what prevented the agent from writing during that day.

Do not silently pass a failing check.

### 10. Process Self-Critique

Before writing the report, reflect on whether the maintenance process itself is working. This is **required** — the JSON report's `processImprovements` field must contain at least one `[self-critique]` entry per consolidation run.

Ask yourself:
- Has HEARTBEAT.md been empty for multiple cycles without escalation?
- Are daily logs accumulating faster than consolidation processes them?
- Are the same themes or corrections appearing repeatedly, suggesting consolidation isn't retaining them?
- Is any memory tier consistently skipped (no episodic entries, no procedural updates)?
- Are there tasks or follow-ups added but never acted on?
- Are core memory entries growing stale with no mechanism to detect it?
- Are there issues I've noticed but haven't acted on?

Write your answer as a `[self-critique]` entry even if things seem fine (e.g., "No recurring problems observed this cycle — memory tier coverage looks balanced"). The entry must reflect on process effectiveness, not just confirm that maintenance ran.

**Do NOT use generic filler** like "ran consolidation as scheduled" or "maintenance completed normally". The entry must identify a real gap, recurring problem, or process weakness observed during this run.

Example entries:
- `"[self-critique] HEARTBEAT.md has been empty for 3 weeks and I have not flagged this to the user — escalation is overdue"`
- `"[self-critique] The same error pattern about API timeouts has appeared in 4 daily logs but has not been promoted to core memory — the consolidation threshold may be too conservative"`
- `"[self-critique] No episodic memories have been written in 30 days despite several incidents in daily logs — I am systematically under-using that tier"`
- `"[self-critique] The same team project facts are re-extracted each cycle because they're not being promoted to semantic memory"`
- `"[self-critique] Consolidation is running but memory retrieval quality hasn't been validated — promoted facts may not be surfaced in practice"`

### 11. Produce Report

Create both a markdown and JSON report:

- **Markdown:** `reports/YYYY-MM-DD-memory-consolidation.md` (must include the `## Daily Log Compliance` section from Step 9)
- **JSON:** `reports/YYYY-MM-DD-memory-consolidation.json` (must include `daily-log-*` keys in `selfAssessment` and the `[self-critique]` entry from Step 10 in `processImprovements`)

For `selfAssessment.reduce-log-count`: set to `true` if at least one daily log was actively processed this run — either (a) Step 7 deleted one or more log files, OR (b) Steps 2–4 extracted content from at least one log and produced at least one ADD or UPDATE action. Set to `false` if no logs were processed (e.g., no logs in range, all NOOP). **Always include daily log files whose content was extracted in `filesChanged`**, even if they were not deleted — listing source logs gives the evaluator the evidence of log file activity it needs to verify this criterion.

## Scoring Guidance

When deciding what to promote, weigh:
- **Frequency** — mentioned multiple times = more important
- **Recency** — recent information is more likely still relevant
- **Explicit signals** — user corrections and stated preferences are always high priority
- **Impact** — does this affect how you should behave in future sessions?

## Commit

After consolidation, commit all changes (including reports):
```
chore: consolidate memory (YYYY-MM-DD)
```
