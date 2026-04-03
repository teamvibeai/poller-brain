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
  "processImprovements": [
    "[self-critique] Daily logs are thin — entries lack enough context to be useful weeks later",
    "[proposal] HEARTBEAT.md should auto-populate pending items from consolidation findings",
    "[blocked] Need base-brain change to add recurring reflection follow-up tracking"
  ],
  "selfAssessment": {
    "reduce-log-count": true,
    "update-relevant-tiers": true,
    "meaningful-decisions": true,
    "no-data-loss": true
  },
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
| `observations` | `string[]` | Specific observations about memory quality, strengths, or gaps (used by `assess-memory-quality` criterion). Each entry MUST name a concrete finding — e.g. "semantic/team-members.md has complete profiles for all 4 active members", "No procedural doc exists for the weekly-standup workflow despite it recurring 5+ times". Generic phrases like "memory looks good" do NOT qualify. |
| `recommendations` | `string[]` | Actionable recommendations for the next maintenance cycle (used by `actionable-recommendations` criterion) |
| `processImprovements` | `string[]` | Self-critique and improvement proposals for the maintenance process itself. Each entry should be prefixed with one of: `[self-critique]` (what is not working in my maintenance process), `[proposal]` (concrete change with rationale), or `[blocked]` (identified but can't fix without admin/base-brain change). Also include a `[follow-up]` entry per previous recommendation that was either acted on or ignored. |
| `selfAssessment` | `object` | Boolean pass/fail per eval criterion (see Eval Criteria below) |
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
| `meaningful-decisions` | Were decisions documented and non-trivial? | At least one decision in the report describes a real choice (not "did routine maintenance") |

### Reflection Criteria

| ID | Criterion | Pass condition |
|----|-----------|----------------|
| `assess-memory-quality` | Did reflection assess current memory quality? | Report includes specific observations about memory strengths or gaps |
| `actionable-recommendations` | Were recommendations actionable? | At least one recommendation is specific enough to act on in the next maintenance cycle |
| `no-data-loss` | Was no valuable information lost? | No files deleted that contained unique information not captured elsewhere |

## One-Time

- **Memory migration**: If `memory/core/` directory does not exist, run the migration described in the `memory` skill. This splits the old monolithic MEMORY.md into the tiered structure. Only needed once per brain.

## Daily

- **Memory consolidation**: Check `memory/.last_consolidation`. If 1+ days old (or missing), run the memory-consolidate skill to process daily logs into long-term memory. **Produce a report.**

## Monthly

- **Memory reflection**: Check `memory/episodic/reflection-*.md` for the last reflection date. If 30+ days old (or none exist), run the memory-reflect skill to assess memory quality. **Produce a report.**
