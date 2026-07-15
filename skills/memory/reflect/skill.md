---
name: memory-reflect
description: |
  Memory self-assessment skill. Run monthly during maintenance heartbeat to
  check memory quality, resolve contradictions, and archive stale entries.
---

# Memory Reflection

Periodic self-assessment of memory quality. Run monthly.

## Checklist

### 0. Previous Recommendations Review

Before starting, find the most recent reflection report in `memory/episodic/reflection-*.md` or `reports/*-memory-reflection.json`. Read its `recommendations` array.

**If no prior reflection exists:** Add to `processImprovements`: `"[self-critique] No prior reflection found — first reflection run; no prior recommendations to review."` This satisfies the `previous-recommendations-reviewed` criterion.

**If a prior reflection exists:** For each recommendation in that report, determine its status: `implemented`, `partially addressed`, or `pending`. Add **at least one entry** to `processImprovements` that names the specific recommendation text and its status. Required format:

```
[self-critique] Prior rec: "<recommendation text>" — status: implemented/partially addressed/pending. <one-sentence reason>.
```

All prior-recommendation review entries MUST appear in `processImprovements`. The `previous-recommendations-reviewed` eval criterion passes only when the report explicitly names at least one prior recommendation and states its status. A generic "reviewed prior recommendations" without naming one fails the criterion.

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

Identify memory gaps AND name the concrete operational consequence — what actually went wrong in recent cycles because of the gap. A gap with no observed impact is structural noise; a gap tied to an observed problem is actionable.

Look at the last 1–2 maintenance cycles (consolidation reports, prior reflections, recent daily logs) for the consequence — not the abstract future risk.

- *Gap-only (not enough):* "Core memory lacks project X context."
- *Gap + observed consequence (the bar):* "Core memory lacks project X context, which caused 3 duplicate pattern entries in last week's consolidations."

**Verification gate — required before logging any gap in `observations`:** Open the last 1–2 consolidation reports or daily logs and confirm you can finish this sentence with a named fact: "…which caused [specific outcome] in [recent cycle/timeframe]." If you cannot — the gap has not yet produced an observed consequence — route it to `processImprovements` as `[proposal]` instead. Vague future-risk language ("this may affect quality", "could cause issues") does NOT qualify as a consequence.

Candidate gap classes to scan:
- Frequently discussed topics with no semantic memory entry
- Team members mentioned often but with no profile in semantic/
- Recurring tasks with no procedural documentation

If a gap exists but has not yet produced any observed consequence, do not log it as an observation. Move it to `processImprovements` as `[proposal] would like to capture X` so future cycles know it is on the radar without inflating the gap list.

**Required format for any gap logged in `observations`:**
`"[Tier/file] [gap language], which caused [specific outcome] in [cycle] on [YYYY-MM-DD]."`
Example: `"No procedural entry exists for post-deploy verification, which caused the 2026-05-15 deploy to miss the smoke-test step."`
If you cannot supply a specific named incident with a date, do NOT include it in `observations` — route it to `processImprovements` as `[proposal]` instead, even if the future risk feels certain. "Lacks X which may affect quality" and "could cause Y" are not consequences.

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

- `observations`: List specific findings from this reflection. Each entry should name a concrete memory strength, OR pair a memory gap with the *operational consequence it has already produced* in recent maintenance cycles. Gap-only observations ("X is missing", "Y is thin") do NOT qualify — they go to `processImprovements` as `[proposal]` instead.

  **Pre-write self-check (required):** Before finalizing this list, scan every draft observation for gap-class words: `lacks`, `missing`, `thin`, `no entry for`, `gap in coverage`, `no mechanism`, `no archival`, `no reduction path`, `no retirement`, `no fallback`, `blocked`, `structurally blocked`, `has been blocked`, `unreachable`, `zero candidates`, `no reachable`, `no path`, `cannot fire`. For each match, confirm the item includes a specific outcome AND a date: "which caused [outcome] in [cycle] on [YYYY-MM-DD]." If you cannot supply both, move the item to `processImprovements` as `[proposal]` — do NOT leave it in `observations`. An observation with gap language but no dated consequence will fail the `gap-impact-analysis` eval criterion.

  Examples:
  - "semantic/team-members.md has complete profiles for all 4 active members" — concrete strength
  - "memory/core/LEARNINGS.md has grown to 80 lines and the last 2 promotions appended new bullets rather than merging into the existing entry, creating 3 near-duplicate rules" — gap + observed consequence
  - "No procedural documentation exists for the weekly-standup workflow, which led to 4 inconsistent invocations across the last 5 standup runs" — gap + observed consequence
  - "episodic/ covers the last 3 months well; the last 2 questions about pre-Q1 incidents required Slack history dives because no episodic entries cover that period" — gap + observed consequence
  - Vague impact language like "this may affect quality" does NOT qualify — the consequence must be specific and already observed.
- `recommendations`: Specific actions for the next maintenance cycle. If any recommendation would benefit all agents (not just this channel), prefix it with `[base-brain]`. **At least one recommendation MUST include all three of: (1) the concrete change to make, (2) the current problem it addresses, and (3) a verifiable success condition** — a checkable outcome that confirms the recommendation was implemented and effective. Format: `"[change] — [problem] — success: [verifiable condition]"`. Examples:
  - "Split semantic/projects.md into per-project files — currently 120 lines, causes slow lookups — success: each resulting file under 60 lines at next reflection"
  - "[base-brain] Add guidance on deduplicating recurring morning-reflection topics — same question appears in consecutive daily logs without resolution — success: next reflection finds no unresolved repeated question across 3 consecutive logs"
- `selfAssessment`: Use the actual reflection eval criterion IDs: `concrete-improvement-proposal`, `previous-recommendations-reviewed`, `gap-impact-analysis`, `verifiable-recommendations`, `deletion-with-preservation-evidence`.
- `processImprovements`: Required for reflection reports. Include at least one entry per prefix type (`[self-critique]`, `[proposal]`, `[blocked]`). Reference prior recommendations that went unacted on. Examples:
  - `[self-critique] Reflection is running 45 days late — monthly schedule not enforced by any heartbeat check`
  - `[proposal] Add a 30-day check for last reflection date to HEARTBEAT.md so it triggers automatically`
  - `[blocked] Cannot self-fix thin daily logs — agents need base-brain guidance on minimum daily log content`

## Commit

After reflection, commit all changes (memory files + both report files) in one commit:
```
chore: memory reflection (YYYY-MM-DD)
```
