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

### 5. Update MEMORY.md Index

After promoting facts, update `MEMORY.md` to reflect the current state of memory.
Keep it concise — topic summaries with pointers to detail files.

### 6. Compress Old Daily Logs

For daily logs older than 30 days:
- Create `memory/daily/weekly-YYYY-Www.md` summaries (one per week)
- Delete the individual daily files that were summarized
- Keep the weekly summary concise (key events and learnings only)

### 7. Update Timestamp

Write the current date to `memory/.last_consolidation`:
```
YYYY-MM-DD
```

### 8. Process Self-Critique

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

### 9. Produce Report

Create both a markdown and JSON report:

- **Markdown:** `reports/YYYY-MM-DD-memory-consolidation.md`
- **JSON:** `reports/YYYY-MM-DD-memory-consolidation.json`

The JSON report MUST include the `processImprovements` field with the `[self-critique]` entry from Step 8.

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
