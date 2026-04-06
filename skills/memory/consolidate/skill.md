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

### 7. Process Self-Critique

Before finishing, explicitly question whether the maintenance process itself is working. Include at least one `[self-critique]` entry in your consolidation report's `processImprovements` field (or in the decisions/observations section) that reflects on the process, not just the outcome.

Ask yourself:
- Has HEARTBEAT.md been empty for multiple cycles without escalation?
- Are the same types of issues appearing repeatedly across consolidation runs?
- Are any memory tiers never being updated, suggesting the routing logic isn't working?
- Is there information that keeps getting missed or lost despite the current process?
- Are there tasks or follow-ups added but never acted on?

Example qualifying entries:
- `[self-critique] HEARTBEAT.md has been empty for 3 consecutive weeks — I should escalate or remove stale placeholders`
- `[self-critique] The same team project facts are re-extracted each cycle because they're not being promoted to semantic memory`
- `[self-critique] No episodic memories have been created in 2 weeks despite significant events being logged daily`

Generic statements like "consolidation ran as scheduled" do NOT qualify. The entry must reflect on whether the process is effective.

### 8. Update Timestamp

Write the current date to `memory/.last_consolidation`:
```
YYYY-MM-DD
```

## Scoring Guidance

When deciding what to promote, weigh:
- **Frequency** — mentioned multiple times = more important
- **Recency** — recent information is more likely still relevant
- **Explicit signals** — user corrections and stated preferences are always high priority
- **Impact** — does this affect how you should behave in future sessions?

## Commit

After consolidation, commit all changes:
```
chore: consolidate memory (YYYY-MM-DD)
```
