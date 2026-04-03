---
name: memory-reflect
description: |
  Memory self-assessment skill. Run monthly during maintenance heartbeat to
  check memory quality, resolve contradictions, and archive stale entries.
---

# Memory Reflection

Periodic self-assessment of memory quality. Run monthly.

## Checklist

### 1. Staleness Check

Scan all memory files for information that may be outdated:
- References to dates more than 90 days old without recent confirmation
- Team member references (people may have changed roles/left)
- Project status references (may be completed or cancelled)
- Tool/process references (may have changed)

**Action:** Mark stale entries with `[STALE?]` or archive to `memory/episodic/archive/`

### 2. Contradiction Check

Look for conflicting information across memory files:
- Same topic with different facts in different files
- Core memory that contradicts semantic memory
- Procedures that reference outdated tools or workflows

**Action:** Resolve contradictions by keeping the most recent/authoritative version. Note the resolution in the updated entry.

### 3. Gap Analysis

Identify areas where memory is thin:
- Frequently discussed topics with no semantic memory entry
- Team members mentioned often but with no profile in semantic/
- Recurring tasks with no procedural documentation

**Action:** Create placeholder files noting the gap for future capture:
```markdown
# [Topic]
<!-- GAP: frequently referenced but no detailed memory yet. Capture details in next relevant conversation. -->
```

### 4. Size Check

Review memory files for bloat:
- Core files over 50 lines should be pruned
- Semantic files over 100 lines should be split
- MEMORY.md should be under 100 lines

**Action:** Split, prune, or archive as needed.

## Output

### 1. Episodic reflection file

Write a reflection report to `memory/episodic/reflection-YYYY-MM-DD.md`:

```markdown
# Memory Reflection — YYYY-MM-DD

## Summary
- Files reviewed: N
- Stale entries found: N
- Contradictions resolved: N
- Gaps identified: N
- Files pruned/archived: N

## Changes Made
- [list of specific changes]

## Gaps to Fill
- [list of identified gaps for future capture]
```

### 2. Maintenance reports (required)

Produce both a markdown and JSON report in `reports/` as required by MAINTENANCE.md.

**Markdown:** `reports/YYYY-MM-DD-memory-reflection.md` — follow the standard report format.

**JSON:** `reports/YYYY-MM-DD-memory-reflection.json` — populate every field:

- `observations`: List specific findings from this reflection. Each entry should name a concrete memory strength or gap found. Examples:
  - "semantic/team-members.md has complete profiles for all 4 active members"
  - "memory/core/LEARNINGS.md has grown to 80 lines — approaching prune threshold"
  - "No procedural documentation exists for the weekly-standup workflow despite it recurring 5+ times"
  - "episodic/ covers last 3 months well; older events missing"
  - Leave no entry vague — "memory looks good" does NOT qualify.
- `recommendations`: Specific actions for the next maintenance cycle. If any recommendation would benefit all agents (not just this channel), prefix it with `[base-brain]`. Examples:
  - "Split semantic/projects.md into per-project files — currently 120 lines"
  - "[base-brain] Add guidance on deduplicating recurring morning-reflection topics to prevent agents repeating the same question across days"
- `selfAssessment`: Include at minimum `assess-memory-quality`, `actionable-recommendations`, `no-data-loss`.

## Commit

After reflection, commit all changes (memory files + both report files) in one commit:
```
chore: memory reflection (YYYY-MM-DD)
```
