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

### Machine-readable report

Every maintenance operation MUST also produce a JSON report alongside the markdown report.

**Location:** `reports/YYYY-MM-DD-{operation-name}.json`

The JSON file is written at the same time as the markdown report, in the same commit.

**Schema:**

```json
{
  "operationType": "consolidation",
  "operationCounts": {
    "created": 0,
    "modified": 0,
    "deleted": 0
  },
  "filesChanged": [
    "memory/core/patterns.md",
    "memory/daily/2026-03-27.md"
  ],
  "decisions": [
    "Merged 3 daily logs into weekly summary",
    "Promoted recurring pattern to core memory"
  ],
  "observations": [
    "Core memory has strong coverage of communication patterns but lacks project-specific context",
    "Daily logs from last week contain redundant entries about standup format"
  ],
  "recommendations": [
    "Add a project-context section to core memory to capture recurring project references",
    "Consolidate standup-related entries into a single communication pattern"
  ],
  "selfAssessment": {
    "reduce-log-count": true,
    "update-relevant-tiers": true,
    "meaningful-decisions": true,
    "no-data-loss": true,
    "daily-log-exists-today": true,
    "daily-log-continuous-appends": true,
    "daily-log-recent-retention": true,
    "daily-log-weekly-coverage": true
  },
  "processImprovements": [
    "[self-critique] What is not working in my maintenance process? What am I ignoring?",
    "[proposal] Concrete change proposal with rationale",
    "[blocked] Things I cannot fix myself — need base-brain change or admin input"
  ],
  "brainCommitSha": "abc123def456789..."
}
```

**Field descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `operationType` | `string` | One of: `consolidation`, `reflection` |
| `operationCounts` | `object` | Count of files created, modified, deleted |
| `filesChanged` | `string[]` | Relative paths of all files changed |
| `decisions` | `string[]` | Plain-text list of decisions made during this run |
| `observations` | `string[]` | Specific observations about memory quality, strengths, or gaps (used by `assess-memory-quality` criterion) |
| `recommendations` | `string[]` | Actionable recommendations for the next maintenance cycle (used by `actionable-recommendations` criterion) |
| `selfAssessment` | `object` | Boolean pass/fail per eval criterion (see Eval Criteria below) |
| `processImprovements` | `string[]` | Self-critique and proposals for process improvement. Each entry must be prefixed with `[self-critique]`, `[proposal]`, or `[blocked]`. At least one entry required per reflection. |
| `brainCommitSha` | `string` | Output of `git rev-parse HEAD` at the time of the report |

**Rules:**
- The `brainCommitSha` MUST be obtained by running `git rev-parse HEAD` in the brain repo.
- The `selfAssessment` keys MUST match the criterion IDs defined in the Eval Criteria section below.
- The JSON file MUST be valid JSON (no trailing commas, no comments).
- Commit the JSON report in the same commit as the markdown report and the maintenance changes.

## Eval Criteria

These criteria are used for self-assessment in the JSON report's `selfAssessment` field. Each criterion is binary: `true` (pass) or `false` (fail). Assess honestly.

### Consolidation Criteria

| ID | Criterion | Pass condition |
|----|-----------|----------------|
| `reduce-log-count` | Did consolidation reduce the number of daily log files? | At least one daily log was processed/archived |
| `update-relevant-tiers` | Were all relevant memory tiers updated? | Changes propagated to appropriate tier (daily -> core, daily -> episodic, etc.) |
| `process-self-critique` | Did the consolidation report include process self-critique? | Report contains at least one entry questioning whether the current maintenance process is working, identifying a meta-level gap or recurring problem (not just operational status) |
| `daily-log-exists-today` | Does today's daily log exist when sessions ran today? | If any session ran today (commits, reports, or MCP activity dated today), memory/daily/YYYY-MM-DD.md for today exists and is non-empty. If today had no sessions yet, this is a pass. |
| `daily-log-continuous-appends` | Was the daily log appended to continuously, not written as a single end-of-session dump? | Today's daily log (or the most recent day with 2+ sessions) contains 2+ distinct timestamped or bulleted entries — not a single summary paragraph written at session end. If the brain has no day with 2+ sessions yet (e.g., new agent, sparse usage), this criterion passes. |
| `daily-log-recent-retention` | Are today's and yesterday's daily logs preserved after consolidation? | After consolidation completes, memory/daily/<today>.md and memory/daily/<yesterday>.md still exist (when they existed before consolidation or were created today) |
| `daily-log-weekly-coverage` | Is daily log coverage healthy across the last 7 days? | Over the last 7 days, days_with_daily_log / days_with_any_session >= 0.8. Days with no session do not count against coverage. |
| `evidence-backed-decisions` | Did consolidation document at least two decisions with specific memory evidence? | At least 2 entries in the decisions array reference specific memory files, observed entry counts, or content patterns encountered during consolidation — not generic process descriptions |

### Reflection Criteria

| ID | Criterion | Pass condition |
|----|-----------|----------------|
| `concrete-improvement-proposal` | Did reflection produce at least one concrete process change proposal? | Report includes at least one specific proposal for changing the maintenance process, with a stated rationale (what should change and why), not merely an observation that something is broken |
| `previous-recommendations-reviewed` | Did reflection review follow-through on previous recommendations? | Report explicitly references at least one recommendation from a prior maintenance cycle and states whether it was implemented, partially addressed, or remains pending |
| `gap-impact-analysis` | Did reflection connect at least one memory gap to a specific operational consequence? | At least one entry in observations identifies a specific memory gap AND explains how that gap caused a concrete problem or reduced maintenance effectiveness in recent cycles |
| `verifiable-recommendations` | Did reflection include at least one recommendation with a stated success criterion? | At least one entry in recommendations specifies: (1) a concrete change to make, (2) the current problem it addresses, AND (3) a verifiable condition that would confirm the recommendation was implemented and effective in a future maintenance cycle |
| `deletion-with-preservation-evidence` | Did reflection explicitly account for each deleted file's content preservation? | For every file deletion recorded in filesChanged (operationCounts.deleted > 0): the report names in decisions or observations the specific destination file where the deleted content was preserved, OR explicitly states the content was redundant with a specifically named existing file. If operationCounts.deleted is 0, the criterion passes automatically. |

## One-Time

- **Memory migration**: If `memory/core/` directory does not exist, run the migration described in the `memory` skill. This splits the old monolithic MEMORY.md into the tiered structure. Only needed once per brain.

## Daily

- **Memory consolidation**: Run `bash scripts/maintenance-guard.sh` first. If it exits non-zero, skip consolidation entirely (no report needed). If it exits 0, run the memory-consolidate skill to process daily logs into long-term memory. **Produce a report.**
  - **Tier coverage check**: Before completing consolidation, verify that each memory tier was explicitly considered: `memory/semantic/` (facts/knowledge), `memory/episodic/` (significant events), `memory/procedural/` (workflows), `memory/core/` (corrections, preferences, lessons). If any daily log contains information relevant to a tier, that tier MUST be updated. Do not stop after updating one tier — check all four.
  - **Log age check**: After promoting content from daily logs, delete any `memory/daily/*.md` files dated more than 7 days ago. This is required to satisfy `reduce-log-count` — the evaluator checks `operationCounts.deleted` and `filesChanged` for actual evidence of log archival, not the self-assessment field. Self-assess `reduce-log-count: true` ONLY if at least one log was actually deleted (`operationCounts.deleted >= 1`). If no logs older than 7 days exist, self-assess `reduce-log-count: false` and note it explicitly in the report as "no daily logs older than 7 days found". Record the outcome in the report: either "archived N logs (7+ days old)" or "no daily logs older than 7 days found".
  - **Recent-log retention (never delete today or yesterday)**: Consolidation MUST NOT delete `memory/daily/<today>.md` or `memory/daily/<yesterday>.md`, regardless of whether their contents have been promoted. Same-day and next-day sessions rely on these files being present to recover context. Only logs dated 2+ days ago are candidates for promotion; only logs dated 7+ days ago are candidates for deletion.
  - **Daily log compliance block**: Every consolidation report MUST include a `## Daily Log Compliance` section in the markdown with observable metrics for the last 7 days. If any metric fails, either backfill (reconstruct entries from git log / reports / this session's memory) or explicitly flag the gap in `processImprovements` as a `[self-critique]`. Example block:
    ```markdown
    ## Daily Log Compliance
    - Coverage (last 7d): 5/7 days with sessions covered ✅
    - Today's log: present, 8 entries, first append 09:14, last 16:42 ✅
    - Continuous appends: 8 distinct timestamped entries (not a single end-of-session dump) ✅
    - Retention: today + yesterday preserved ✅
    - Empty/trivial logs: 0
    - Gaps: 2026-04-11 (had sessions per git log, no daily log written)
    ```
    Populate the `selfAssessment` fields `daily-log-exists-today`, `daily-log-continuous-appends`, `daily-log-recent-retention`, and `daily-log-weekly-coverage` based on this block.

## Twice Weekly

- **Memory reflection**: Check `memory/episodic/reflection-*.md` for the last reflection date. If 3+ days old (or none exist), run the memory-reflect skill to assess memory quality. **Produce a report.**
