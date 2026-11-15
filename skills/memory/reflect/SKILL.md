---
name: memory-reflect
description: |
  Memory self-assessment skill. Run monthly during maintenance heartbeat to
  check memory quality, resolve contradictions, and archive stale entries.
---

# Memory Reflection

Periodic self-assessment of memory quality. Run monthly.

Before any heartbeat, scheduled maintenance, or reflection action (including Bash, `log-write`, writes, or commits), use file-read tools to check the owner-provisioned `MAINTENANCE_DISABLED` file at the channel brain root. Empty files and files with a free-text reason both disable maintenance; subdirectory copies do not apply. If the marker exists, owner policy disables maintenance, or you cannot write files in the brain repo or run the guard scripts by any available tool (e.g. Write/Edit or Bash), skip maintenance/reflection. An opted-out run executes nothing: do not log, produce a report, or change reports, dates, lifecycle markers, or unfinished-cycle evidence. If the triggering message explicitly requests output (a live-thread ask or a scheduled `promptTemplate` asking for a summary), send one short line saying maintenance/reflection could not run and why. Otherwise, return exactly `NO_FURTHER_RESPONSE_NEEDED`.

## Checklist

### 0. Previous Recommendations Review

Before starting, find the most recent reflection report in `memory/episodic/reflection-*.md` or `reports/*-memory-reflection.json`. Read its recommendations (the `recommendations` array in JSON) before writing the current draft. Record `review_mode` for the check below: `required` when prior recommendations exist, `first-run` when no prior reflection exists, or `empty-prior` when the prior recommendations list is explicitly empty. An unreadable prior report or an unknown/missing list is not an empty list; resolve it or report `[blocked]`.

**If no prior reflection exists:** Add to `processImprovements`: `"[self-critique] No prior reflection found — first reflection run; no prior recommendations to review."` This satisfies the `previous-recommendations-reviewed` criterion. In the episodic report's `## Previous Recommendations Review` section, write exactly `- Not applicable: first reflection run; no prior recommendations to review.`

**If the prior recommendations list is empty:** Add `"[self-critique] Prior reflection has an empty recommendations list; no prior recommendations to review."` to `processImprovements`. In the same episodic section, write exactly `- Not applicable: prior recommendations list is empty.` Neither exemption needs a fabricated lifecycle status.

**If prior recommendations exist:** Name every recommendation in the episodic review section and assign one lifecycle status with reason/evidence:

| Lifecycle status | Reporting meaning |
| --- | --- |
| `Closed` | The recommendation has been completed, with evidence that its success condition was met. |
| `Moot` | The recommendation no longer applies, with evidence explaining why. |
| `Pending` | The recommendation remains actionable and unfinished, without a committed deadline. |
| `Pending+Deadline` | The recommendation remains unfinished with an explicit deadline; record that date and the next action. |
| `Failure-Mode` | Follow-through has become a recurring or systemic failure; name the observed failure and supporting evidence. |

Consult the brain's recommendation lifecycle procedure, if available, for closure and transition rules; its absence does not disable this vocabulary check. Do not invent automatic transitions, deadlines, or recurrence thresholds from these labels.

Also retain the legacy `implemented`, `partially addressed`, or `pending` summary in JSON. Add **at least one entry** to `processImprovements` naming a specific prior recommendation, its legacy status, and its lifecycle status. Required format:

```
[self-critique] Prior rec: "<recommendation text>" — status: <implemented/partially addressed/pending>; lifecycle: <label>; <reason>.
```

Keep named-recommendation JSON entries and the legacy summary; assess lifecycle and legacy status from evidence rather than assuming a one-to-one mapping. Keep `processImprovements` within MAINTENANCE.md's **five-entry cap**, including the required prefixes; use Markdown for the complete per-recommendation review. Keep both reports consistent without adding evaluator keys. The `previous-recommendations-reviewed` eval criterion still requires a named prior recommendation and legacy status; generic "reviewed prior recommendations" fails.

**Mechanical sub-check (required after writing the current episodic report, before finalization):** Run the grep-based helper with the mode determined above, substituting the current report date:

```bash
bash "$CLAUDE_CONFIG_DIR/skills/memory/reflect/scripts/check-previous-recommendations.sh" \
  "memory/episodic/reflection-YYYY-MM-DD.md" "$review_mode"
```

The helper extracts only `## Previous Recommendations Review` and requires at least one standalone `- Status: <label>` field in `required` mode. Its `grep -E` expression matches exact, case-sensitive tokens, including escaped `Pending\+Deadline`; vocabulary lists, fenced examples, labels elsewhere, partial tokens, and legacy lowercase `pending` do not pass. Exempt modes require their exact not-applicable line in that section. A missing/duplicate section, missing/unreadable report, or command error fails even in exempt modes. The check verifies presence, not completeness or substantive closure: still review every recommendation and its evidence.

On failure, repair the current draft and rerun the same check. If repair is blocked, put a visible `[blocked] Previous Recommendations Review validation failed: <reason>` in the maintenance Markdown and a terse `[blocked]` entry in `processImprovements`, respecting the five-entry cap; set `selfAssessment.previous-recommendations-reviewed` to `false` and do not claim validation passed. Do not edit past reports.

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

**`MEM_REGISTRY.md` inline policy prose:** if the registry carries inline policy-prose sections (e.g. a HOLD-lifecycle rule) rather than just `[MEM-NNN]` rows, that is live content, not the dead REMOVED rows the automated archival (Step 9d in `consolidate/SKILL.md`, poller-brain#217) relocates — deciding whether/where to move it is a manual reflection judgment. Relocate such prose verbatim to `memory/procedural/{topic}.md` and leave a one-line pointer in the registry (e.g. `> 📖 [section names] relocated to [procedural/{topic}.md](procedural/{topic}.md)`). Do not fold this into the automated consolidate step (poller-brain#217).

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

## Previous Recommendations Review
### Prior recommendation: <specific recommendation text>
- Status: <one lifecycle label from Step 0>
- Reason/evidence: <what happened, with a file/cycle reference; deadline and next action if applicable>

## Changes Made
- [list of specific changes]

## Gaps to Fill
- [list of identified gaps for future capture]
```

Always include the canonical review section. Repeat its recommendation block for every prior recommendation; for a first run or an empty prior list, replace the blocks with the exact not-applicable line from Step 0. After writing this file, run Step 0's mechanical sub-check before finalizing the maintenance reports or committing.

### 2. Maintenance reports (required)

Produce both a markdown and JSON report in `reports/` as required by MAINTENANCE.md.

**Markdown:** `reports/YYYY-MM-DD-memory-reflection.md` — follow the standard report format.

**JSON:** `reports/YYYY-MM-DD-memory-reflection.json` — populate every field:

- `operationType`: MUST be exactly `"reflection"` as a top-level field (NOT inside `selfAssessment`). This is the *single hard-required* field: the poller **permanently deletes** any report missing it — no retry, and the run never reaches the eval pipeline. After writing the JSON, grep the file for `"operationType"` and confirm (a) the value is `reflection` and (b) the match is a *top-level* key — same indentation as `"observations"`/`"selfAssessment"`, not nested inside `selfAssessment` (a nested match still gets the report deleted). If absent or nested, fix it before committing.
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

  **Pre-write self-check (required):** Before finalizing recommendations, confirm at least one entry explicitly contains all three parts in this order: `[change] — [problem] — success: [verifiable condition]`. Check each draft recommendation for the "—" separator pattern with a named problem in the middle. A recommendation structured as `"[change]; success = [condition]"` or `"[change] — success: [condition]"` fails this criterion because it omits the problem statement. If no entry has all three parts, rewrite or add one recommendation that explicitly names the current problem before the success condition.

  **Minimum-bar fallback:** Every reflection runs a size check (Step 4) that measures at least one memory file. If you are uncertain any draft recommendation satisfies the three-part test, append one based on a file measured in Step 4: `"[Trim/archive/split] [filename] — currently [N] bytes ([Nx] over [threshold] threshold) — success: [filename] under [threshold] at next reflection."` This template mechanically supplies all three required parts from evidence already in hand.
- `selfAssessment`: Use the actual reflection eval criterion IDs: `concrete-improvement-proposal`, `previous-recommendations-reviewed`, `gap-impact-analysis`, `verifiable-recommendations`, `deletion-with-preservation-evidence`.

  **Pre-write deletion accounting check (required when any files were deleted):** Before finalizing the report, check `operationCounts.deleted`. If deleted count > 0, enumerate every deleted file and confirm that `decisions` or `observations` contains an entry for each one that either (a) names the specific destination file where the content was preserved (e.g., "Deleted memory/daily/2026-03-15.md — content merged into memory/episodic/march-2026.md"), or (b) explicitly states the content was redundant with a specifically named existing file (e.g., "Deleted semantic/old-topic.md — fully superseded by semantic/new-topic.md"). Generic phrases like "archived old logs" or "no data loss" without naming specific files DO NOT qualify and will fail the `deletion-with-preservation-evidence` criterion. Every deleted file must be individually accounted for.
- `processImprovements`: Required for reflection reports. Include at least one entry per prefix type (`[self-critique]`, `[proposal]`, `[blocked]`). Reference prior recommendations that went unacted on. Examples:
  - `[self-critique] Reflection is running 45 days late — monthly schedule not enforced by any heartbeat check`
  - `[proposal] Add a 30-day check for last reflection date to HEARTBEAT.md so it triggers automatically`
  - `[blocked] Cannot self-fix thin daily logs — agents need base-brain guidance on minimum daily log content`

## Commit

After reflection, commit all changes (memory files + both report files) in one commit:
```
chore: memory reflection (YYYY-MM-DD)
```
