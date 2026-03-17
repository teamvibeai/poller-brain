---
name: memory
description: |
  Structured memory management system. This skill is always active — it governs
  how agents read, write, and organize memory across sessions. Use the tiered
  memory directory structure for all persistence.
---

# Memory System

Your workspace has a structured memory system. Follow these rules for all memory operations.

## Directory Structure

```
memory/
├── core/              # Long-term curated facts (high signal, regularly pruned)
│   ├── PREFERENCES.md # User/team preferences and communication style
│   ├── LEARNINGS.md   # Key lessons learned from experience
│   └── MISTAKES.md    # Past mistakes to avoid repeating
├── daily/             # Daily session logs (append-only, auto-consolidated)
│   └── YYYY-MM-DD.md  # Raw notes from each day's sessions
├── semantic/          # Factual knowledge about the team/project/domain
├── episodic/          # Significant events and their outcomes
└── procedural/        # How-to knowledge and workflows
```

## Session Startup Loading

At the start of every session, silently load memory in this order:
1. **`MEMORY.md`** (workspace root) — the index of what you know
2. **`memory/core/*.md`** — all core memory files
3. **`memory/daily/`** — today's log and yesterday's log (if they exist)

Do not announce that you're reading memory. Just do it.

## Daily Logging

During each session, append observations to `memory/daily/YYYY-MM-DD.md`:
- Key decisions made
- New information learned about the team/project
- Tasks completed or started
- Corrections received
- Important context from conversations

Format: use timestamps and brief entries. Create the file if it doesn't exist.

```markdown
## 2026-03-17

- 14:30 — Learned that Alice prefers email over Slack for approvals
- 14:45 — Fixed the deploy script; root cause was missing AWS region
- 15:10 — User corrected: reports should go to #general, not #reports
```

## Importance Signals — What Goes Where

**Write immediately to core/ when you encounter:**
- Explicit corrections ("no, do it this way") → `memory/core/MISTAKES.md`
- Stated preferences ("I prefer...", "always do...") → `memory/core/PREFERENCES.md`
- Lessons from failures or successes → `memory/core/LEARNINGS.md`

**Write to daily log for everything else:**
- Routine observations, task progress, conversation notes

**Promote to semantic/episodic/procedural during consolidation:**
- Factual knowledge (team structure, project details) → `memory/semantic/`
- Significant events (launches, incidents, decisions) → `memory/episodic/`
- Workflows and procedures learned → `memory/procedural/`

## Routing Logic

When you learn something new, route it:

| Signal | Destination | Example |
|--------|------------|---------|
| User corrects you | `core/MISTAKES.md` | "No, the API key goes in the header, not query param" |
| User states preference | `core/PREFERENCES.md` | "Always use bullet points in summaries" |
| You discover something useful | `core/LEARNINGS.md` | "The staging DB resets every Sunday" |
| Factual info about team/project | `daily/` → later `semantic/` | "Alice is the frontend lead" |
| Something notable happened | `daily/` → later `episodic/` | "Production went down for 2h due to DNS" |
| You figure out how to do something | `daily/` → later `procedural/` | "Deploy requires SSO login first" |

## Searching Deeper Memory

When you need context beyond core/ and daily logs:
- Use `Grep` to search across `memory/semantic/`, `memory/episodic/`, `memory/procedural/`
- Use `Glob` to find files by pattern (e.g., `memory/episodic/incident-*.md`)
- Don't load everything — search for what's relevant to the current conversation

## Updating MEMORY.md

`MEMORY.md` is the index — a concise summary of what you know and pointers to detailed files.
Keep it under 100 lines. Update it when core memories change significantly.

## Migration

Migration runs during **maintenance heartbeat** (not regular sessions — don't slow down user interactions). See `MAINTENANCE.md` for the trigger. Run migration **once**, then it's done.

### How to detect

Migration is needed if ANY of these are true:
- `memory/core/` directory does not exist
- `MEMORY.md` exists AND contains actual content (not just an index with pointers to files)
- Old-format daily logs exist at `memory/YYYY-MM-DD.md` (not in `memory/daily/`)

Skip migration if `memory/core/` already exists with files in it — it's already been done.

### Migration steps

1. **Create directory structure:**
   ```
   mkdir -p memory/core memory/daily memory/semantic memory/episodic memory/procedural
   ```

2. **Split monolithic MEMORY.md into core files:**
   - Read the existing `MEMORY.md`
   - Extract corrections, mistakes, things to avoid → `memory/core/MISTAKES.md`
   - Extract preferences, communication style, how users want things done → `memory/core/PREFERENCES.md`
   - Extract lessons learned, discoveries, useful knowledge → `memory/core/LEARNINGS.md`
   - If there's factual knowledge about team/project (people, roles, structure), put it in `memory/semantic/team.md` or similar
   - **Rewrite `MEMORY.md`** as a concise index (under 100 lines) — topic summaries with pointers to the detail files

3. **Move old daily logs:**
   - Move any `memory/YYYY-MM-DD.md` files to `memory/daily/YYYY-MM-DD.md`

4. **Commit the migration:**
   ```
   git add memory/ MEMORY.md
   git commit -m "chore: migrate memory to tiered structure"
   ```

### Important

- **Don't lose information** — everything from the old MEMORY.md must end up somewhere in the new structure
- **Be generous with categorization** — if unsure where something goes, put it in `core/LEARNINGS.md`
- **Keep core files focused** — each file should have a clear purpose, not be a dump of everything
- Do this silently — don't ask the user for permission, just migrate and commit
