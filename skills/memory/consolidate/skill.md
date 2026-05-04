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

**All steps below are mandatory on every consolidation run.** There is no "lightweight" or "partial" mode. Even when daily logs are empty or steps 2–4 produce zero promotions, Step 6 (Regenerate SUMMARY.md) MUST still execute. Never skip or abbreviate steps because a run "has nothing to process."

### 0. Archive TODAY.md

Before processing, archive `memory/TODAY.md` to the daily/ directory:

1. Read `memory/TODAY.md` — extract the date header(s) (format: `# YYYY-MM-DD`)
2. For each date section in TODAY.md:
   - Append its content **verbatim** to `memory/daily/YYYY-MM-DD.md` (create if needed). Copy every bullet point and line exactly as written — do NOT summarize, truncate, rephrase, or condense entries. The daily archive must be a byte-for-byte copy of the original content.
3. Reset `memory/TODAY.md` with today's date header and an immediate consolidation log entry:
   ```
   # YYYY-MM-DD

   - HH:MM — memory consolidation started
   ```
   This entry is required — it ensures today's log is non-empty even if no user sessions follow, so the daily-log-weekly-coverage metric counts this day.

This ensures daily logs accumulate in `memory/daily/` while TODAY.md stays fresh for the current day.

**Report tracking (required):** After completing this step, add both `memory/TODAY.md` and the target `memory/daily/YYYY-MM-DD.md` to the JSON report's `filesChanged` array. This is mandatory — evaluators check `filesChanged` for `memory/TODAY.md` to verify this step ran. Omitting it causes the report to fail the `today-md-archived` criterion even when the archival was performed correctly.

If `memory/TODAY.md` doesn't exist, do NOT skip this step. Instead: create `memory/TODAY.md` now with today's date header and the consolidation start entry (step 3 above). Add `memory/TODAY.md` to `filesChanged`. There is no archive destination since there was no prior content — omit the `memory/daily/YYYY-MM-DD.md` entry from filesChanged in this case only.

**Step 0 checkpoint (required before proceeding):** Pause here and explicitly verify:
- [ ] `memory/TODAY.md` is in your working `filesChanged` list
- [ ] `memory/daily/YYYY-MM-DD.md` (today's date) is in `filesChanged` (unless TODAY.md did not exist prior to this run)

If either entry is missing, add it now. Do NOT advance to Step 1 with these entries missing — the `today-md-archived` eval criterion checks `filesChanged` and will fail if TODAY.md is absent, even when the archival was performed correctly.

### 1. Scan Daily Logs

Read all files in `memory/daily/` dated since the last consolidation date.
If no `.last_consolidation` file exists, process the last 14 days of logs.

### 1b. Process `[MEM-NNN]` Tracked Keys (priority)

**Before** extracting general facts, scan all daily logs from step 1 for lines containing `[MEM-\d+]`, `[MEM-<word>]` (malformed), or `[REMEMBER]` (backward compat). These are tracked memory entries and must be promoted with **guaranteed priority** — they are never filtered by heuristics.

> **⚠️ Anti-pattern: auto-memory is NOT persistent memory.**
> Claude Code's built-in auto-memory (`~/.claude/projects/.../memory/`) is ephemeral — it does not survive re-clones, machine changes, or container restarts. NEVER treat auto-memory as a substitute for writing to the brain's `memory/` tier files. `[MEM-NNN]` items MUST be physically written to `memory/core/` or `memory/semantic/` files. Claiming "already captured in auto-memory" is NOT valid — auto-memory is provider-specific and not part of our memory model.

#### Auto-fix malformed keys

If a `[MEM-<word>]` tag is found where `<word>` is NOT a number (e.g., `[MEM-feedback]`, `[MEM-TAG]`):
1. Assign the next available sequential number (read `memory/MEM_REGISTRY.md`, find highest number, increment)
2. Replace the malformed tag in the daily log with the correct `[MEM-N]` format
3. Add the corrected key to the registry with status `ACTIVE`
4. Log the fix in the report: "Auto-fixed malformed key: [MEM-feedback] → [MEM-4]"
5. Process as a normal `[MEM-NNN]` entry

#### Handling `[REMEMBER]` backward compatibility

If a `[REMEMBER]` tag is found (without a `[MEM-NNN]` key):
1. Assign the next available key (read `memory/MEM_REGISTRY.md`, find highest number, increment)
2. Add the new key to the registry with status `ACTIVE`
3. Process as if it were a `[MEM-NNN]` entry

#### For each `[MEM-NNN]` entry:

1. **Check the registry** — if the key isn't in `memory/MEM_REGISTRY.md` yet (new entry from a regular session), add it with status `ACTIVE`, today's date, and a short description.

2. **Classify** the destination based on content:
   - Preference / communication style / workflow → `memory/core/PREFERENCES.md`
   - Lesson / factual discovery → `memory/core/LEARNINGS.md`
   - Correction / mistake to avoid → `memory/core/MISTAKES.md`
   - Team/project fact → `memory/semantic/{topic}.md`

3. **Check for duplicates** — grep the target file for the same `[MEM-NNN]` key or similar content. If a match exists:
   - **UPDATE** the existing entry with any new detail (preserve the `[MEM-NNN]` key)
   - If identical, **NOOP** (don't create duplicates)

4. **Write** to the destination file. The `[MEM-NNN]` key MUST be preserved in the promoted entry:
   ```markdown
   # In core/LEARNINGS.md:
   - [MEM-3] Deploy flow: main = STAGING only, produkce = version tag (v0.0.X)...
   ```

5. **Verify promotion landed** — after writing, grep the target file for a key phrase from the promoted entry. If the grep returns no match, the write failed — retry or flag as an error in the report. Do not proceed to the next item until verification passes.

6. **Report tracking:** Add each promoted `[MEM-NNN]` item to the markdown report under a `## [MEM] Promotions` section, listing: key, original entry, destination file, action taken (ADD/UPDATE/NOOP), verification result (VERIFIED/FAILED).

If no `[MEM-NNN]` or `[REMEMBER]` tags are found, skip this step and note "no [MEM] tags found" in the report.

### 1c. MEM Lifecycle — Obsolescence Check

Review entries in `memory/MEM_REGISTRY.md` with status `ACTIVE`:

1. **Check for contradictions** — if newer daily log entries contradict or supersede an existing ACTIVE entry, mark it `OBSOLETE`:
   - Update registry: status → `OBSOLETE`, set obsoleted date
   - Update the content file: change `[MEM-N]` to `[MEM-N:obsolete]`
   - The entry stays in the content file for one consolidation cycle

2. **Process previously OBSOLETE entries** — for entries marked `OBSOLETE` in a *previous* consolidation run (check git history or the obsoleted date vs. last consolidation date):
   - Remove the `[MEM-xxx:obsolete]` line from the content file
   - Update registry: status → `REMOVED`
   - **Never delete the registry row** — it stays for audit trail

3. **Report tracking:** Add lifecycle changes to the markdown report under `## [MEM] Lifecycle` section.

### 2. Extract Facts

For each daily log, identify (excluding already-processed `[MEM-NNN]` / `[REMEMBER]` entries):
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
- **How this memory works** — static block explaining what's in context vs. what requires lookup (copy verbatim from the template in the memory skill)
- **Identity** — who you are (from channel brain CLAUDE.md)
- **Key Rules** — actionable rules from LEARNINGS.md, each with a pointer to the source file for detail (e.g., "Always verify live data before trade proposals (detail: core/LEARNINGS.md)")
- **Preferences** — actionable preferences from PREFERENCES.md with pointer to source file
- **Active Projects** — from recent episodic/ entries
- **Deep Memory Index** — pointers to all memory tiers with topic summaries

The "How this memory works" block MUST be the first section in SUMMARY.md. It is static content — do not rephrase or compress it, copy it from the template.

**Key Rules and Preferences must be actionable, not just labels.** Bad: "stale prices". Good: "Always verify live data before trade proposals (detail: core/LEARNINGS.md)". The pointer tells the agent where to find the full context if needed.

This replaces the old "Update MEMORY.md" step. SUMMARY.md is the new authoritative index.

**Report tracking (required):** Add `memory/SUMMARY.md` to the JSON report's `filesChanged` array immediately after completing this step — do not defer to Step 12. Also set `selfAssessment["summary-md-regenerated"]` to `true` in the JSON report at this point. Evaluators check both `filesChanged` and `selfAssessment["summary-md-regenerated"]` to verify this step ran. Omitting `memory/SUMMARY.md` from `filesChanged` fails the `summary-md-regenerated` criterion even when the file was correctly regenerated.

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

### 9. MEM Audit & Memory Metrics

Run integrity checks on the MEM registry and collect memory size metrics.

#### 9a. MEM Integrity Check

If `memory/MEM_REGISTRY.md` exists:

1. **Count ACTIVE keys** — grep the registry for ACTIVE entries
2. **Verify presence** — for each ACTIVE key, grep across `memory/` (excluding `MEM_REGISTRY.md` and `daily/`) to confirm the key exists in at least one content file. A missing ACTIVE key = integrity violation.
3. **Check sequence** — extract all key numbers, verify gaps match REMOVED/OBSOLETE entries in the registry. An unexplained gap = potential data loss.
4. **Compare with previous run** — if the previous consolidation report exists, compare ACTIVE counts. A decrease without corresponding OBSOLETE/REMOVED entries = alarm.

Record results in the markdown report under `## MEM Audit`:
```markdown
## MEM Audit
- Total keys: 12
- ACTIVE: 10, OBSOLETE: 1, REMOVED: 1
- New this cycle: 2 (MEM-011, MEM-012)
- Obsoleted this cycle: 0
- Integrity: ✅ all ACTIVE keys found in content files
- Sequence: ✅ no unexplained gaps
```

Populate JSON report `selfAssessment`:
- `mem-integrity-check` — `true` if all ACTIVE keys are present and sequence is clean, `false` otherwise

If `memory/MEM_REGISTRY.md` doesn't exist (pre-migration brains), skip and set `mem-integrity-check` to `true` (no keys to check).

#### 9b. Memory File Size Metrics

Measure sizes of key memory files and include a `## Memory Metrics` section in the markdown report.

**How to measure:** Run `wc -c` on each file (skip files that don't exist):
- `CLAUDE.md`, `memory/SUMMARY.md`, `memory/TODAY.md`, `memory/MEM_REGISTRY.md`
- `memory/core/LEARNINGS.md`, `memory/core/PREFERENCES.md`, `memory/core/MISTAKES.md`

**Include this table in the markdown report:**
```markdown
## Memory Metrics
| File | Size (bytes) | Threshold | Status |
|------|-------------|-----------|--------|
| CLAUDE.md | 2800 | 10000 | :white_check_mark: |
| SUMMARY.md | 4200 | 8000 | :white_check_mark: |
| LEARNINGS.md | 3100 | 5000 | :white_check_mark: |
| MEM_REGISTRY.md | 800 | 5000 | :white_check_mark: |
| PREFERENCES.md | 500 | — | — |
| MISTAKES.md | 0 | — | — |
| TODAY.md | 1100 | — | — |
```

**Thresholds** (flag as :warning: if exceeded):
- `CLAUDE.md` > 10000 — risk: instruction overload
- `SUMMARY.md` > 8000 — risk: context bloat
- `LEARNINGS.md` > 5000 — risk: too many rules to follow
- `MEM_REGISTRY.md` > 5000 — risk: registry too large (archive REMOVED entries)

#### 9c. CLAUDE.md Gradual Reduction

If the Memory Metrics table (Step 9b) shows `CLAUDE.md` exceeding 10000 bytes, perform **one** small extraction per consolidation cycle:

1. **Identify one block** (10–30 lines) in `CLAUDE.md` that is procedural, reference-like, or domain-specific knowledge — not core identity or behavioral rules. Good candidates:
   - Step-by-step workflows → move to `memory/procedural/{topic}.md`
   - Domain knowledge / data structures → move to `memory/semantic/{topic}.md`
   - Rules that duplicate base-brain CLAUDE.md or `@`-imported SUMMARY.md → delete

2. **Extract it:**
   - Create the target file (or append to an existing one) with the extracted content
   - Remove the block from `CLAUDE.md` entirely — do NOT leave a pointer in CLAUDE.md (saves space)
   - Instead, ensure `memory/SUMMARY.md` references the new file so the agent can find it via the always-loaded `@` import

3. **Log it** in the markdown report under `## CLAUDE.md Reduction`:
   - What was moved, from where to where, size delta
   - Why this block was chosen (procedural/reference/duplicate)
   - Confirm the SUMMARY.md pointer was added

4. **Constraints:**
   - Move *at most 1 block per cycle* — gradual reduction, not a big-bang refactor
   - *Never move* identity sections, `@` import lines, or core behavioral rules
   - If unsure whether a block is safe to move, skip this step and note "no safe candidate found" in the report
   - If `CLAUDE.md` is under 10000 bytes, skip this step entirely

This ensures steady progress toward the threshold while allowing time to detect regressions between cycles.

### 10. Assess Daily Log Compliance

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

### 11. Process Self-Critique

Before writing the report, reflect on whether the maintenance process itself is working. This is **required** — the JSON report's `processImprovements` field must contain at least one `[self-critique]` entry per consolidation run.

Ask yourself:
- Has HEARTBEAT.md been empty for multiple cycles without escalation?
- Are daily logs accumulating faster than consolidation processes them?
- Are the same themes or corrections appearing repeatedly, suggesting consolidation isn't retaining them?
- Is any memory tier consistently skipped (no episodic entries, no procedural updates)?
- Are there tasks or follow-ups added but never acted on?
- Are core memory entries growing stale with no mechanism to detect it?
- Are there issues I've noticed but haven't acted on?
- Are MEM keys being lost or not promoted correctly?

Write your answer as a `[self-critique]` entry even if things seem fine (e.g., "No recurring problems observed this cycle — memory tier coverage looks balanced"). The entry must reflect on process effectiveness, not just confirm that maintenance ran.

**Do NOT use generic filler** like "ran consolidation as scheduled" or "maintenance completed normally". The entry must identify a real gap, recurring problem, or process weakness observed during this run.

Example entries:
- `"[self-critique] HEARTBEAT.md has been empty for 3 weeks and I have not flagged this to the user — escalation is overdue"`
- `"[self-critique] The same error pattern about API timeouts has appeared in 4 daily logs but has not been promoted to core memory — the consolidation threshold may be too conservative"`
- `"[self-critique] No episodic memories have been written in 30 days despite several incidents in daily logs — I am systematically under-using that tier"`
- `"[self-critique] The same team project facts are re-extracted each cycle because they're not being promoted to semantic memory"`
- `"[self-critique] Consolidation is running but memory retrieval quality hasn't been validated — promoted facts may not be surfaced in practice"`

### 12. Produce Report

**Pre-report `filesChanged` verification:** Before writing the report, confirm these required entries are in `filesChanged`:
- `memory/SUMMARY.md` — mandatory every run (Step 6). Also confirm `selfAssessment["summary-md-regenerated"]` is set to `true`. If missing from `filesChanged`: do NOT just add the filename — go back and execute Step 6 now, regenerate `memory/SUMMARY.md` from current memory state, then add it to `filesChanged` and set `selfAssessment["summary-md-regenerated"]` to `true`. Skipping Step 6 silently is not allowed.
- `memory/TODAY.md` — mandatory every run (Step 0). If missing from `filesChanged`: do NOT just add the filename — go back and execute Step 0 now (reset TODAY.md with today's header and a consolidation start entry if not already done, append any existing content to today's daily log), then add `memory/TODAY.md` to `filesChanged`. Skipping Step 0 silently is not allowed.
- `memory/daily/YYYY-MM-DD.md` — the archived daily log (Step 0); add it now if missing (omit only when TODAY.md did not exist prior to this run)
- `memory/MEM_REGISTRY.md` — if any `[MEM-NNN]` entries were processed or lifecycle changes made in steps 1b/1c; add it now if missing

Create both a markdown and JSON report:

- **Markdown:** `reports/YYYY-MM-DD-memory-consolidation.md` (must include `## Daily Log Compliance` from Step 10, `## MEM Audit` from Step 9a, and `## Memory Metrics` from Step 9b)
- **JSON:** `reports/YYYY-MM-DD-memory-consolidation.json` (must include `daily-log-*` and `mem-integrity-check` keys in `selfAssessment`, and the `[self-critique]` entry from Step 11 in `processImprovements`)

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
