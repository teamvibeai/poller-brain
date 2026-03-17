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

## Commit

After reflection, commit all changes:
```
chore: memory reflection (YYYY-MM-DD)
```
