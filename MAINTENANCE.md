# Base Brain Maintenance

These tasks are universal — they apply to all agents regardless of workspace.
During heartbeat sessions, execute these alongside your channel's HEARTBEAT.md tasks.

## Reporting Convention

Every background maintenance operation MUST produce a report file. This gives users visibility into what the agent did without digging through git history.

### Report location

`reports/YYYY-MM-DD-{operation-name}.md`

Examples: `reports/2026-03-18-memory-consolidation.md`, `reports/2026-03-18-memory-reflection.md`

### Report format

```markdown
# Maintenance Report: {operation-name}
date: {YYYY-MM-DD}
trigger: {heartbeat|scheduled|auto}

## Context *(optional — omit for routine operations)*
{Why was this needed?}

## What happened
{Human description of what the agent did.}

## Changes
- ACTION  path/to/file — brief description

## Decisions
{At least one real choice made this run — not "did routine maintenance". Document the actual decision and why. Examples of meaningful decisions: "Deleted memory/daily/2026-02-10.md because all facts were already captured in semantic/"; "Moved project X deadline from episodic to semantic because it recurred 3 times"; "Skipped promoting a note about error Y because it was a one-off with no lasting impact". Generic phrases like "ran consolidation as scheduled" or "processed logs" do NOT qualify.}

## Consequences
- ✅ {Positive impact}
- ⚠️ {What to watch out for}

## Files changed
- Created/Modified/Deleted: file.md

Commit: {hash}
```

### Rules

- Reports are **append-only** — never edit past reports.
- The **Consequences** section must always include at least one `⚠️` warning item.
- The **Context** section is optional — omit it for routine/scheduled operations where the trigger is self-explanatory.
- Commit the report in the same commit as the maintenance changes it describes.

## One-Time

- **Memory migration**: If `memory/core/` directory does not exist, run the migration described in the `memory` skill. This splits the old monolithic MEMORY.md into the tiered structure. Only needed once per brain.

## Daily

- **Memory consolidation**: Check `memory/.last_consolidation`. If 1+ days old (or missing), run the memory-consolidate skill to process daily logs into long-term memory. **Produce a report.**

## Monthly

- **Memory reflection**: Check `memory/episodic/reflection-*.md` for the last reflection date. If 30+ days old (or none exist), run the memory-reflect skill to assess memory quality. **Produce a report.**
