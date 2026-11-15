# Base Brain Maintenance

These tasks are universal — they apply to all agents regardless of workspace.
Execute them during scheduled maintenance sessions. (Legacy: heartbeat sessions also trigger them while heartbeat is being phased out — see CLAUDE.md "Task Scheduling & Heartbeat" section. Tracked in `teamvibeai/teamvibe.ai#102`.)

Before any heartbeat, scheduled maintenance, or reflection action (including Bash, `log-write`, writes, or commits), use file-read tools to check the owner-provisioned `MAINTENANCE_DISABLED` file at the channel brain root. Empty files and files with a free-text reason both disable maintenance; subdirectory copies do not apply. If the marker exists, owner policy disables maintenance, or you cannot write files in the brain repo or run the guard scripts by any available tool (e.g. Write/Edit or Bash), skip maintenance/reflection. An opted-out run executes nothing: do not log, produce a report, or change reports, dates, lifecycle markers, or unfinished-cycle evidence. If the triggering message explicitly requests output (a live-thread ask or a scheduled `promptTemplate` asking for a summary), send one short line saying maintenance/reflection could not run and why. Otherwise, return exactly `NO_FURTHER_RESPONSE_NEEDED`. Both guards skip with `maintenance_disabled` (exit 1) and still report state requiring inspection; opting out does not repair it.

## Reporting Convention

Every background maintenance operation MUST produce a report file. This gives users visibility into what the agent did without digging through git history. **The report file + git commit is the delivery channel — not Slack.** A bare maintenance/heartbeat trigger carries no explicit ask (see CLAUDE.md "CRITICAL: How to Respond" scope note), so do not additionally write to Slack in any form (`send_message`, file/snippet upload, `update_message`) as a summary, even when the run surfaced something noteworthy, blocked, or worth escalating (`poller-brain#327`) — it is silent because there was no ask, regardless of what the run produced. The only reason to post is if the *triggering* message itself explicitly asked for it — e.g. a `create_scheduled_message` run whose `promptTemplate` says "...and post summary" — in which case that instruction is the ask, and follow it.

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

For consolidation, also include `## SUMMARY.md Reduction` as required by the consolidation skill's Step 6: previous final UTF-8 byte size (or `not present`), post-regeneration size, each accepted section/destination with whole-SUMMARY bytes before → after, final size and remaining overage, successful-relocation budget used/allowed, and stop reason (`under cap`, `budget exhausted`, `no safe candidate`, `no progress`, or `deferred: structural stall`). Record rejected attempts and pointer/source reconciliations there too, including runs with no relocations. Add every accepted relocation destination (including reused verified copies) and any destination created/modified before a rejected replacement or interruption to the JSON `filesChanged` array alongside `memory/SUMMARY.md`; keep `selfAssessment["summary-md-regenerated"] = true`. These measurements belong in the markdown report; no new JSON fields are required.

For CLAUDE.md Step 9c and SUMMARY.md Step 6 only, follow the consolidation skill's **per-file reduction retry contract (#466)**. A conclusive full search with zero successful reductions proving the oversized remainder entirely protected/pointer-only may record `structurally stalled, needs human review`. Uncertainty, failed verification, interruption, `no progress`, `budget exhausted`, and productive over-cap reduction do not qualify. Keep one versioned `consolidation-retry-v1` block under its own `## Reduction Retry Cadence` heading, outside Tier Coverage/other metric sections, with independent entries for both targets in every completed markdown report; the read-only `scripts/consolidation-retry.mjs` uses only verified committed completion evidence at the pre-Step-0 HEAD, including committed JSON when its on-disk copy was consumed. Missing/untrusted state or changed inputs means search, after the existing completion/repair guard. Preserve the actual attempt and exact 168-hour deadline across deferrals; explicit human review requests invalidate backoff. This never schedules or forces an idle/disabled brain to run.

On deferral, report `deferred: structural stall; next eligible <time>; last actual search <time>` with source report/commit, current byte overage, and the human-review flag. Keep the warning in Consequences and `processImprovements` using existing fields. Do not claim a fresh search or repeat a long candidate narrative. SUMMARY still regenerates with a fresh timestamp, reconciles/validates pointers, appears in `filesChanged`, and sets `selfAssessment["summary-md-regenerated"] = true`; Step 9b metrics and integrity audits still run. Report the SUMMARY budget as 0 used / the fixed allowed amount. Due searches retain the #452 fixed relocation budget, strict shrinking/preservation checks and all caps. Clear retry state on under-cap results or successful progress. No new JSON schema or evaluator keys are introduced.

For semantic split review, include `## Semantic Lifecycle` with the explicit `migrated`, `justified no-split`, or `concrete handoff` outcome and evidence required by [consolidation Step 5b](skills/memory/consolidate/SKILL.md#citation-safe-split-runbook). Link its durable inventory/relocation map or handoff (source fingerprint, plan, owner, UTC deadline, blocker); summarize the outcome in the existing JSON `decisions` field, without new schema/evaluator fields. Reflection carries the same task forward and reports overdue escalation under its previous-recommendations review. Keep past reports unchanged; their citations use the original revision and relocation map for historical lookup.

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
  "heartbeatStatus": {
    "present": false,
    "nonEmpty": false,
    "itemCount": 0
  },
  "reflectionStatus": {
    "lastReflectionDate": "2026-05-25",
    "daysSinceReflection": 11,
    "overdueThresholdDays": 3,
    "isOverdue": true,
    "nonConformingReflectionFiles": 0
  },
  "pushHealth": {
    "branch": "main",
    "upstream": "refs/remotes/origin/main",
    "unpushedCommits": 0,
    "upstreamRefMissing": false,
    "lastPushOkAt": "2026-01-01T12:00:00.000Z",
    "oldestUnpushedAt": null
  },
  "rescueBranches": {
    "count": 0,
    "oldestAgeDays": null,
    "refs": []
  },
  "skills": {
    "counts": {"current": 0, "outdated": 0, "modified": 0, "waiting-upstream": 0, "own": 0, "not-discovered": 0},
    "entries": []
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
| `decisions` | `string[]` | Plain-text list of decisions made during this run. **One sentence per item, action-first phrasing (verb + object + minimal evidence). Cap at 5 items.** When a criterion (e.g. `evidence-backed-decisions`) requires a specific memory file or count, name it inline — do not narrate the discovery process. |
| `observations` | `string[]` | Specific observations about memory quality, strengths, or gaps (used by `assess-memory-quality` criterion). **One sentence per item, fact-first (the observation itself, not how you found it). Cap at 5 items.** |
| `recommendations` | `string[]` | Actionable recommendations for the next maintenance cycle (used by `actionable-recommendations` criterion). **Imperative, one sentence per item. Include success criterion inline when required (see `verifiable-recommendations`). Cap at 5 items.** |
| `selfAssessment` | `object` | Boolean pass/fail per eval criterion (see Eval Criteria below) |
| `processImprovements` | `string[]` | Self-critique and proposals for process improvement. Each entry must be prefixed with `[self-critique]`, `[proposal]`, or `[blocked]`. At least one entry required per reflection. **One sentence per item after the prefix. Cap at 5 items.** |
| `heartbeatStatus` | `object` | Self-reported state of the brain's `HEARTBEAT.md` file at consolidation time. `present` (bool): file exists. `nonEmpty` (bool): file contains at least one line that is not blank, a heading, an HTML comment, or a completed `- [x]` task. `itemCount` (int): number of unchecked task lines (`- [ ]`). Used by eval pipeline to track heartbeat deprecation progress (`teamvibeai/teamvibe.ai#102`). |
| `reflectionStatus` | `object` | Self-reported reflection cadence, computed by `scripts/reflection-guard.sh` (poller-brain#157). `lastReflectionDate` (string \| null): date parsed from the newest `memory/episodic/reflection-*.md` filename, or `null` if none exists yet. `daysSinceReflection` (int \| null): days elapsed since that date. `overdueThresholdDays` (int): the threshold used, from `REFLECTION_OVERDUE_THRESHOLD_DAYS` (default 3). `isOverdue` (bool): normally `daysSinceReflection >= overdueThresholdDays` (or `true` when no reflection has ever run), **except** when `idleSkipped` is `true` — an idle-skip forces `isOverdue: false` even past the threshold (poller-brain#391). `nonConformingReflectionFiles` (int): count of `reflection-*.md` files that don't match the strict `reflection-YYYY-MM-DD.md` shape (e.g. a stray `reflection-template.md` or a split `reflection-2026-08-12-part2.md`) — lets the fleet metric distinguish "reflects, but under an unparseable filename" from "never reflected" when `lastReflectionDate` is `null`. `idleSkipped` (bool): `true` only when the guard skipped an otherwise-overdue reflection because no consolidation report since the last reflection promoted anything (`poller-brain#391`, mirrors `#168`'s consolidation idle-skip) — distinguishes "healthy idle, nothing new to reflect on" from "genuinely 3+ days lagging" for the fleet metric; always `false` when `isOverdue` is `true`. Used by the eval pipeline to track fleet-wide reflection lag. |
| `pushHealth` | `object` | Required in every consolidation report: copy `PUSH_HEALTH_JSON` from `scripts/push-health.sh`. Local tracking-ref snapshot only, with no network calls: `branch`, configured full `upstream` ref (or null), `unpushedCommits` (HEAD commits absent from upstream, or null if missing), `upstreamRefMissing` (true when no upstream ref), `lastPushOkAt` (upstream tip commit ISO committer time, the last state known to reach the remote, not actual push time), `oldestUnpushedAt` (earliest unpushed ISO committer time, or null). Git errors yield all nulls plus `error`, exit 0. |
| `rescueBranches` | `object` | Self-reported state of this brain's own outstanding git "rescue" branches — `conflict/<brainId>-<timestamp>` refs the platform pushes to `origin` when a brain's push hits a real (non-auto-rebasable) conflict, so no commits are lost (`teamvibeai/teamvibe.ai#247`). Populated by running `git ls-remote origin 'refs/heads/conflict/<own-brainId>-*'` — **not** `git branch -r --list`, which only sees already-fetched refs and misses branches pushed by the platform since the brain's last fetch. `count` (int): number of matching refs found for this brain's own `<brainId>` prefix (never another brain's — see "Rescue Branch Detection" below). `oldestAgeDays` (int \| null): age in days of the oldest match, derived from the `<timestamp>` segment embedded in its ref name; `null` when `count` is 0 or any matching timestamp is uncertain. `refs` (string[]): the full matching ref names. Omit this object if the remote query fails; record the failure in `observations` instead of reporting zero refs. Detection and required age-based escalation — see "Rescue Branch Detection" for the durable ledger, uncertainty handling, prohibition on automated resolution, and cleanup convention. Used by the eval pipeline's fleet-wide "outstanding rescue branches" signal (count + oldest age). |
| `skills` | `object` | Output of `brain-skills report` (`data`): `counts` per state (`current`, `outdated`, `modified`, `waiting-upstream`, `own`, `not-discovered`) and `entries` with each skill's state and provenance. Run every maintenance session; see "Skills" below. |
| `brainCommitSha` | `string` | Output of `git rev-parse HEAD` at the time of the report |

**Rules:**
- `operationType` is a REQUIRED top-level field (`consolidation` or `reflection`) — the poller permanently deletes any report missing it, with no retry, before it reaches the eval pipeline. Always set it and verify it is present before committing.
- The `brainCommitSha` MUST be obtained by running `git rev-parse HEAD` in the brain repo.
- The `pushHealth` field is ALWAYS required in every consolidation report: run `bash "$CLAUDE_CONFIG_DIR/scripts/push-health.sh"` in the brain cwd and copy the `PUSH_HEALTH_JSON: {...}` object, including any `error`.
- If `pushHealth.unpushedCommits > 50` or `pushHealth.upstreamRefMissing === true`, add an `observations` item.
- The `rescueBranches` field MUST be obtained by running `git ls-remote origin 'refs/heads/conflict/<own-brainId>-*'` (not `git branch -r --list`) — after a successful query, populate it even when `count` is 0 (`refs: []`, `oldestAgeDays: null`). On query failure, omit it and record uncertainty in `observations`; failure is not zero refs. See "Rescue Branch Detection" below.
- The `selfAssessment` keys MUST match the criterion IDs defined in the Eval Criteria section below.
- The JSON file MUST be valid JSON (no trailing commas, no comments).
- Commit the JSON report in the same commit as the markdown report and the maintenance changes.
- **Brevity: each item in `decisions` / `observations` / `recommendations` / `processImprovements` is ONE sentence (max ~200 chars). Cap each list at 5 items.** Reports are read by both humans and the eval pipeline — terse, fact-first writing scales; verbose narration does not. Reasoning belongs in the markdown report's Decisions section, NOT the JSON. If a criterion needs a specific evidence reference (e.g. a memory filename, a count), name it inline; do not describe the discovery process. The markdown report can still narrate in full — only the JSON list items need to be terse.

## Skills

Every maintenance session runs `status` and `report` through the `skill-maintenance`
skill (`npx tsx "$CLAUDE_CONFIG_DIR/skills/skill-maintenance/scripts/brain-skills.ts"`;
fallback: the script in that skill's own directory). Run `sync <name>` only for
pure SHA bumps: `outdated` entries with no local edits or pending upstream PR.
Then run `lint` and `report` again, and put the report's `data` under `skills` in
the maintenance JSON report. Commit skill content and both locks together.
New skills or new sources require a PR reviewed by the brain owner, never
auto-merge. Use `ensure <name> <source>#<path> --ref main` when the brain's policy
requires a mandatory skill (first customer: `work-management`); its first install
still requires that PR. Modified and waiting-upstream copies need review.

## Eval Criteria

These criteria are used for self-assessment in the JSON report's `selfAssessment` field. Each criterion is binary: `true` (pass) or `false` (fail). Assess honestly.

### Consolidation Criteria

| ID | Criterion | Pass condition |
|----|-----------|----------------|
| `reduce-log-count` | Did consolidation reduce the number of daily log files? | At least one daily log was processed/archived |
| `update-relevant-tiers` | Were all relevant memory tiers updated? | Changes propagated to appropriate tier (daily -> core, daily -> episodic, etc.) |
| `process-self-critique` | Did the consolidation report include process self-critique? | Report contains at least one entry questioning whether the current maintenance process is working, identifying a meta-level gap or recurring problem (not just operational status) |
| `daily-log-exists-today` | Does today's daily log exist when sessions ran today? | If any session ran today (commits, reports, or MCP activity dated today), memory/daily/YYYY-MM-DD.md for today exists and is non-empty. Per-report applicability: if today had no sessions yet, EXCLUDE the report from passCount and totalCount (not a pass or fail — the criterion does not apply to inactive brains). |
| `daily-log-continuous-appends` | Was the daily log appended to continuously, not written as a single end-of-session dump? | Today's daily log (or the most recent day with 2+ sessions) contains 2+ distinct timestamped or bulleted entries — not a single summary paragraph written at session end. Per-report applicability: if the brain has no day with 2+ sessions in the evaluation window (new agent, sparse usage, or inactive), EXCLUDE the report from passCount and totalCount. |
| `daily-log-recent-retention` | Are today's and yesterday's daily logs preserved after consolidation? | After consolidation completes, memory/daily/<today>.md and memory/daily/<yesterday>.md still exist (when they existed before consolidation or were created today). Per-report applicability: if neither today's nor yesterday's daily log existed before consolidation (no session activity in the last 2 days), EXCLUDE the report from passCount and totalCount — there is nothing to retain. |
| `daily-log-weekly-coverage` | Is daily log coverage healthy across the last 7 days? | Over the last 7 days, days_with_daily_log / days_with_any_session >= 0.8. Days with no session do not count against coverage. Per-report applicability: if days_with_any_session == 0 (zero-session week — brain was inactive), EXCLUDE the report from passCount and totalCount. |
| `evidence-backed-decisions` | Did consolidation document at least two decisions with specific memory evidence? | At least 2 entries in the decisions array reference specific memory files, observed entry counts, or content patterns encountered during consolidation — not generic process descriptions |
| `summary-md-regenerated` | Was memory/SUMMARY.md regenerated during consolidation? | memory/SUMMARY.md appears in filesChanged, indicating the consolidated long-term memory index was updated. If the brain has not yet migrated to the SUMMARY.md workflow (no memory/SUMMARY.md exists), this criterion passes — the migration will create it. |
| `today-md-archived` | Was memory/TODAY.md archived and reset during consolidation? | memory/TODAY.md appears in filesChanged, indicating the daily working log was archived to memory/daily/ and reset for the new day. If the brain has not yet migrated to the TODAY.md workflow, this criterion passes. |
| `at-imports-configured` | Are @memory/SUMMARY.md and @memory/TODAY.md imports configured in CLAUDE.md? | The consolidation report's Daily Log Compliance section or selfAssessment confirms that the channel brain CLAUDE.md contains both @memory/SUMMARY.md and @memory/TODAY.md references. If the brain has not yet migrated, this criterion passes. |
| `no-summary-manual-edit` | Was memory/SUMMARY.md left untouched during regular sessions? | Between consolidation runs, memory/SUMMARY.md was only modified by maintenance commits (consolidation/reflection). If any regular-session commit modified SUMMARY.md, this criterion fails. If no regular-session commits touched SUMMARY.md, pass. |
| `session-capture-logged` | Were session capture writes to semantic/ logged in TODAY.md? | For every regular-session commit that created or modified a file in memory/semantic/, a corresponding log entry exists in memory/TODAY.md (or the archived daily log) mentioning the file or 'session capture'. If no semantic/ files were modified during regular sessions, pass automatically. |
| `semantic-naming-convention` | Do new semantic/ files follow kebab-case naming convention? | All files created in memory/semantic/ since the last consolidation use kebab-case naming (lowercase, hyphens, no underscores or spaces, .md extension). Examples: stepforge.md, vest-liquidation.md. If no new semantic/ files were created, pass automatically. |
| `session-capture-has-context` | Do new semantic/ files from session capture include a Context section? | Every file created in memory/semantic/ during regular sessions (not maintenance) contains a heading '## Context' or '## Kontext' with at least one line of text below it. This ensures reference files explain why they exist. If no new session-capture files were created, pass automatically. |
| `reflection-overdue` | Is reflection cadence within the mechanical threshold? | Pass: `reflectionStatus.isOverdue === false`, OR reflection was performed in this same maintenance pass (`filesChanged` includes a `memory/episodic/reflection-*.md` entry). Fail: otherwise (including `isOverdue === true` and any `null`/malformed value). Do NOT re-derive the day-threshold comparison from `daysSinceReflection`/`overdueThresholdDays` — `scripts/reflection-guard.sh` is the sole source of truth for `isOverdue`, including its own boundary condition and the `daysSinceReflection: null` case for a brain that has never reflected. Sourced from `scripts/reflection-guard.sh` output (poller-brain#157). |

### Reflection Criteria

| ID | Criterion | Pass condition |
|----|-----------|----------------|
| `concrete-improvement-proposal` | Did reflection produce at least one concrete process change proposal? | Report includes at least one specific proposal for changing the maintenance process, with a stated rationale (what should change and why), not merely an observation that something is broken |
| `previous-recommendations-reviewed` | Did reflection review follow-through on previous recommendations? | Report explicitly references at least one recommendation from a prior maintenance cycle and states whether it was implemented, partially addressed, or remains pending; preserve this legacy summary in `processImprovements` and its five-entry cap, while adding the complete lifecycle review and mechanical check from `skills/memory/reflect/SKILL.md` Step 0 in episodic Markdown (explicit not-applicable for first run / empty prior list); repair failed checks or visibly report `[blocked]` without claiming a pass |
| `gap-impact-analysis` | Did reflection connect at least one memory gap to a specific operational consequence? | At least one entry in observations identifies a specific memory gap AND explains how that gap caused a concrete problem or reduced maintenance effectiveness in recent cycles. Per-report applicability: if observations contains zero gap-class entries (no language like 'lacks', 'missing', 'thin', 'no entry for', 'gap in coverage'), the report is excluded from scoring (treated as not-applicable for this criterion). The criterion only evaluates reports where at least one gap-class observation is present after the poller-brain#95 routing rule moves gap-only entries to processImprovements. |
| `verifiable-recommendations` | Did reflection include at least one recommendation with a stated success criterion? | At least one entry in recommendations specifies: (1) a concrete change to make, (2) the current problem it addresses, AND (3) a verifiable condition that would confirm the recommendation was implemented and effective in a future maintenance cycle |
| `deletion-with-preservation-evidence` | Did reflection explicitly account for each deleted file's content preservation? | For every file deletion recorded in filesChanged (operationCounts.deleted > 0): the report names in decisions or observations the specific destination file where the deleted content was preserved, OR explicitly states the content was redundant with a specifically named existing file. If operationCounts.deleted is 0, the criterion passes automatically. |

## Pending Issues (deprecated)

`PENDING_ISSUES.md` is deprecated in favor of `mcp__teamvibe-api__submit_feedback`
(see CLAUDE.md's "Reporting Issues" section) — most agents don't have GitHub
repo access to create issues, which the old file-based flow implicitly
assumed. Do not write new entries to `PENDING_ISSUES.md`.

## One-Time

- **Memory migration**: If `memory/core/` directory does not exist, run the migration described in the `memory` skill. This splits the old monolithic MEMORY.md into the tiered structure. Only needed once per brain.
- **`PENDING_ISSUES.md` migration**: If this file exists with `status: pending` entries, submit each one via `mcp__teamvibe-api__submit_feedback` — infer `type`/`priority` from the entry's content (the old format didn't have them) and include the original `repo` in `context` — then delete the file. Only needed once per brain.

## Daily

- **Memory consolidation**: Run `bash "$CLAUDE_CONFIG_DIR/scripts/maintenance-guard.sh"` first. If it exits non-zero, skip consolidation entirely (no report needed); report any `consolidation_inspect: true` result and inspect the marker/history/reports. An unfinished marker requires explicit audited `consolidation-marker.sh repair` before any fresh start. If the guard exits 0 with `consolidation_needed: true`, first run `bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" start .` and require exit 0 **before any maintenance log or archive mutation**, then run `npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/log-write.ts" "maintenance: consolidation session"` **before** invoking the memory-consolidate skill — this stamps today's date section into TODAY.md so that the consolidate skill's Step 0 archive creates `memory/daily/<today>.md` (required for `daily-log-exists-today`). Then run the memory-consolidate skill to process daily logs into long-term memory, proceeding directly to Step 0 from this invocation's successful `start` using its date/HEAD. A later invocation must stop on an unfinished marker. **Produce a report.**
  - **Durable cycle lifecycle:** `consolidation-marker.sh start|inspect|clear|repair [brain_dir]` keeps the UTC cycle date and starting HEAD in worktree-specific Git metadata (`git rev-parse --git-path consolidation-start`), written atomically via temporary file + rename. `inspect` and state detection are read-only. An unfinished marker blocks every later invocation before cadence, including across UTC midnight; inspect and use the skill's explicit audited `repair` procedure. After the skill's exact final commit and committed markdown/JSON pair are verified, run `bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" clear .`; it requires the starting HEAD to be an ancestor of both checkpoint and final. JSON consumption is allowed when its committed Step 12a copy proves the pair. Repair requires captured inspect output and archive/report review notes, moves the original marker to a timestamped `.broken` backup, and preserves the audit in Git metadata. Use `repair` instead of manual marker removal. A leftover lifecycle lock requires inspection before any new start.
  - **Idle-brain skip (`teamvibeai/poller-brain#168`)**: `maintenance-guard.sh` also skips the entire run (exit 1, no report) when the last `CONSOLIDATION_IDLE_STREAK_MIN` (default 2) `reports/*-memory-consolidation.md` reports each show a `## Tier Coverage` section with at least four tier lines (starting with `- `) and no markdown file reference (`[A-Za-z0-9_./-]+\.md`), `MEM-` key followed by a digit, or case-insensitive "Updated" anywhere in the block (update lines must name the changed file per the Accuracy rule below), even if 24h/48h have elapsed — read from the markdown report specifically, since the JSON counterpart is deleted by the platform (v0.1.54+) almost immediately after commit and cannot serve as a detection source — up to `CONSOLIDATION_IDLE_FALLBACK_HOURS` (default 168h/7d), after which it forces a run regardless, so a chronically idle brain still gets a periodic check-in (fresh SUMMARY.md timestamp, heartbeat/weekly-coverage self-report). This skips the whole run; within an authorized run only the Step 6/9c candidate searches have the narrow per-file retry exception above — regeneration and all other consolidate steps stay mandatory-when-run (see SKILL.md's "no lightweight/partial mode" note, reinstated 2026-04-29 after an earlier partial-skip pattern broke `summary-md-regenerated`). Activity in `memory/TODAY.md` bypasses this idle streak and restores the existing 24h window / 48h fallback policy when any threshold is met: lines containing `[MEM-…]` (including malformed tags) or `[REMEMBER]` anywhere (`CONSOLIDATION_ACTIVITY_MEM_MIN`, default 1), or file size in bytes (`CONSOLIDATION_ACTIVITY_BYTES_MIN`, default 32768), per pb#560. A non-numeric or `0` threshold disables the idle-skip (fail-open by design).
  - **Tier coverage check**: Before completing consolidation, verify that each memory tier was explicitly considered: `memory/semantic/` (facts/knowledge), `memory/episodic/` (significant events), `memory/procedural/` (workflows), `memory/core/` (corrections, preferences, lessons). If any daily log contains information relevant to a tier, that tier MUST be updated. Do not stop after updating one tier — check all four. Every consolidation report MUST include a `## Tier Coverage` section documenting each tier's status — either what was updated or an explicit "no new content" confirmation:
    ```markdown
    ## Tier Coverage
    - core/ (corrections, preferences, lessons): Updated PREFERENCES.md with MEM-12 ✅
    - semantic/ (facts, knowledge): No new content — confirmed ✅
    - episodic/ (significant events): No significant events — confirmed ✅
    - procedural/ (workflows): No new workflows — confirmed ✅
    ```
    Set `selfAssessment.update-relevant-tiers: true` only when all four tiers appear in this section, each either updated or explicitly confirmed as not needing updates.
    **Anti-pattern (fails the criterion):** Writing a single sentence like "All four memory tiers stable — no new content" does NOT satisfy this requirement. The 4-line checklist above is mandatory in every consolidation report, including idle/static days. "No new content — confirmed ✅" is a valid passing entry, but each tier must appear as its own line.
    **Accuracy rule:** Before writing the Tier Coverage section, verify each claimed update against your `filesChanged` list. Only write "Updated [file]" for tier entries whose files actually appear in `filesChanged`. Do NOT claim a tier was updated from memory alone — a false "updated" entry will cause this criterion to fail.
    **Idle-day passing rule:** All four entries saying "No new content — confirmed ✅" is a valid PASS. Set `selfAssessment.update-relevant-tiers: true` whenever the complete 4-line checklist is present, even if every line confirms no change. The criterion tests whether you checked all tiers, not whether any tier file changed this cycle.
  - **Registry trim coverage (Step 9e, #505)**: `skills/memory/scripts/mem-registry-trim.ts` rejects pointer rewrites when distinctive row tokens are absent from the selected destination file. Read its additive `contentCoverage` JSON field and report missing-token rejections even when no rows are proposed. **Rejected means do not hand-trim either: move the missing content into the destination first, then rerun and review.** Rows flagged "no verifiable tokens" remain eligible but require manual content verification. See `skills/memory/consolidate/SKILL.md` Step 9e for extraction and matching rules; citation ambiguity rules are unchanged.
  - **Log age check**: After promoting content from daily logs, delete old `memory/daily/*.md` files per the threshold in `skills/memory/consolidate/SKILL.md` Step 7 ("Archive Old Daily Logs") — that skill is the single source of truth for the exact day count; this file intentionally does not restate the number, to avoid the two drifting out of sync again (`teamvibeai/poller-brain#318`). Self-assess `reduce-log-count: true` if any of the following occurred: (1) a daily log was deleted (Step 6), (2) content was extracted and promoted from a daily log (Steps 2–4), OR (3) TODAY.md was archived to `memory/daily/` this consolidation run — this is the common case and applies to every consolidation that uses the TODAY.md workflow. **Archiving TODAY.md satisfies this criterion even if the total daily-log file count stays the same** — the criterion evaluates whether log processing activity occurred, not whether the file count literally decreased. Include in `filesChanged`: all processed source daily log files AND the newly created `memory/daily/YYYY-MM-DD.md` archive file when TODAY.md was archived — listing both source and archive files gives the evaluator evidence of log file activity. Add a `decisions` entry in the form: "Archived memory/TODAY.md to memory/daily/YYYY-MM-DD.md" (or "Deleted memory/daily/YYYY-MM-DD.md — content preserved in [file]") so the evaluator has explicit text evidence of log processing independent of the filesChanged array. If none of these occurred, self-assess `reduce-log-count: false` and note it explicitly in the report. Record the outcome with the concrete day-count actually in effect this run (read from `SKILL.md` Step 7 at run time, not restated here): either "archived N logs (older than X days)" or "no daily logs older than X days found", substituting the real number for X. Stating the actual number in the report — not just citing the source — is what makes future drift between the spec and observed practice detectable (this is exactly how `teamvibeai/poller-brain#318` was originally caught). **Consistency check:** `reduce-log-count` and `today-md-archived` must agree — if `today-md-archived: true`, then `reduce-log-count` must also be `true` (the TODAY.md archive counts as a processed log). Never set them to different values.
  - **Recent-log retention (never delete today or yesterday)**: Consolidation MUST NOT delete `memory/daily/<today>.md` or `memory/daily/<yesterday>.md`, regardless of whether their contents have been promoted. Same-day and next-day sessions rely on these files being present to recover context. Only logs dated 2+ days ago are candidates for promotion; deletion candidacy follows the same SKILL.md Step 7 threshold as the Log age check above — not a separately maintained number here.
  - **Report file age check**: After committing today's maintenance report, delete any `reports/*.md` files dated more than 30 days ago. The JSON-report cleanup landed in platform v0.1.54; the markdown counterparts were never wired up and have been accumulating since. Git history preserves deleted reports (`git log --diff-filter=D -- reports/` retrieves the SHA, `git show <sha>:reports/<file>` retrieves content) so the on-disk copy can be retired safely. Include the deleted files in `filesChanged` and add a `decisions` entry in the form: "Deleted reports/YYYY-MM-DD-{name}.md (30+ days old, preserved in git history)". Skip the entry entirely if no `reports/*.md` files were older than 30 days. Tracks `teamvibeai/teamvibe.ai#36`.
  - **Daily log compliance block**: Every consolidation report MUST include a `## Daily Log Compliance` section in the markdown with observable metrics for the last 7 days. If any metric fails, either backfill (reconstruct entries from git log / reports / this session's memory) or explicitly flag the gap in `processImprovements` as a `[self-critique]`. Example block:
    ```markdown
    ## Daily Log Compliance
    - Coverage (last 7d): 5/6 session-days logged (1 idle day excluded from denominator) ✅
    - Today's log: present, 8 entries, first append 09:14, last 16:42 ✅
    - Continuous appends: 8 distinct timestamped entries (not a single end-of-session dump) ✅
    - Retention: today + yesterday preserved ✅
    - Empty/trivial logs: 0
    - Gaps: 2026-04-11 (had sessions per git log, no daily log written)
    ```
    Populate the `selfAssessment` fields `daily-log-exists-today`, `daily-log-continuous-appends`, `daily-log-recent-retention`, and `daily-log-weekly-coverage` based on this block.
    **`daily-log-weekly-coverage` self-assessment rule:** Compute coverage as: `days_with_daily_log / days_with_any_session` — idle days (no commits, reports, or MCP activity) are excluded from the denominator. **Maintenance-only days are NOT idle**: any day when consolidation ran (producing commits or reports) counts as a session day even if no user spoke in the channel — always run `log-write.ts` before consolidation to ensure the daily log exists for that day. Write the ratio using session days: e.g. "5/6 session-days logged (1 idle day excluded from denominator)", not "5/7 days". **If initial coverage < 0.8:** before accepting failure, attempt to backfill any gap-days — run `git log --format="%ad %s" --date=short --after="YYYY-MM-DD" --before="YYYY-MM-DD"` for each missing session-day, then create a retrospective entry via `log-write.ts "[YYYY-MM-DD retrospective] brief description from commit"`. Successfully backfilled logs raise coverage and may flip selfAssessment to `true`. Set to `true` only if this ratio is ≥ 0.8. If < 0.8, you MUST do BOTH of the following or this criterion automatically FAILS:
    1. Set `selfAssessment.daily-log-weekly-coverage: false`
    2. Add a `[self-critique]` entry in `processImprovements` naming the specific missing days and why (e.g., `[self-critique] Coverage 5/6 session-days this week — 2026-04-11 and 2026-04-12 had sessions but no log written`)

    The evaluator reads the compliance block directly and ignores a `true` selfAssessment when the block shows < 0.8. **Omitting the `[self-critique]` entry causes an automatic failure for this criterion — it is not optional.**

    **`daily-log-exists-today` self-assessment rule:** Set `daily-log-exists-today: true` only if `memory/daily/YYYY-MM-DD.md` for today is non-empty — an archive created from an empty TODAY.md fails this criterion. **Pre-archive check:** Before archiving TODAY.md, verify it contains at least one substantive entry. If TODAY.md is empty or contains only reset-template content, write one entry first: `npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/log-write.ts" "maintenance: consolidation session"`. This ensures the archive is never empty — the consolidation report itself counts as session activity, so the criterion is always applicable when consolidation runs.

## Twice Weekly

- **Memory reflection**: Run `bash "$CLAUDE_CONFIG_DIR/scripts/reflection-guard.sh"` first. If it exits 0, reflection is due — run the memory-reflect skill to assess memory quality. **Produce a report.** If it exits non-zero, skip it (no reflection report needed) — either not yet due, or idle-skipped because no consolidation report since the last reflection promoted anything (`reflectionStatus.idleSkipped`, poller-brain#391).
  - **`reflectionStatus` field is ALWAYS required**, in every consolidation report, whether or not reflection ran this pass — this is not conditional on the guard's exit code. `scripts/reflection-guard.sh` prints a `REFLECTION_STATUS_JSON: {...}` line with `lastReflectionDate`, `daysSinceReflection`, `overdueThresholdDays`, `isOverdue`, `idleSkipped`. Copy those fields into `reflectionStatus` (poller-brain#157) — if reflection ran this pass, run the guard again *after* it completes so the reported values reflect the just-written `reflection-*.md` file, not the stale pre-run state.

## Heartbeat → Scheduled Messages Migration

Heartbeat is deprecated (`teamvibeai/teamvibe.ai#102`). During every consolidation, agents MUST sweep `HEARTBEAT.md` if it exists in the channel brain:

1. Read `HEARTBEAT.md`. For each unchecked `- [ ]` task:
   - Convert to a `create_scheduled_message` call (`runAt` for one-time, `cron` for recurring) — see CLAUDE.md "Migration recipe" section.
   - Delete the migrated line from `HEARTBEAT.md`.
2. Remove all completed `- [x]` lines.
3. If the file is now empty (or contains only headings/comments), delete it.
4. Record in the consolidation report's `decisions`: how many items migrated, file kept or deleted.
5. Populate `heartbeatStatus` in the JSON report (always — even when `HEARTBEAT.md` does not exist):

   ```json
   "heartbeatStatus": {
     "present": <true if HEARTBEAT.md exists at brainCommitSha, else false>,
     "nonEmpty": <true if file has any line that isn't blank/heading/HTML comment>,
     "itemCount": <number of unchecked '- [ ]' lines>
   }
   ```

   This is the canonical signal the eval pipeline aggregates to track deprecation progress. Channel brain repos are private and distributed across customer GH orgs — the eval pipeline cannot read them directly, so each brain MUST self-report.

The goal is `HEARTBEAT.md` absent from every brain repo so the platform-side heartbeat code can be removed.

## Rescue Branch Detection

Tracks `teamvibeai/teamvibe.ai#247`. When a brain's git push hits a real
(non-auto-rebasable) conflict, the platform pushes the local branch to
`origin` as a `conflict/<brainId>-<timestamp>` ref before reporting the
error, so no commits are lost. Outstanding rescue refs need visibility and,
when stale, an accountable human triage request (`poller-brain#481`). Resolution
remains a separate human/agent judgment call.

During every consolidation, detect, report, and evaluate escalation for this
brain's own outstanding rescue refs before generating the reports:

Before the rescue-branch steps, run `bash "$CLAUDE_CONFIG_DIR/scripts/push-health.sh"`
in this brain's cwd and copy its `PUSH_HEALTH_JSON` object to `pushHealth` in
every consolidation report, including when it reports an error; this check uses
only local refs and never fetches or contacts GitHub.

1. Run `git ls-remote origin 'refs/heads/conflict/<own-brainId>-*'` —
   **not** `git branch -r --list`, which only sees refs already fetched into
   the local clone and would miss a branch the platform pushed since the
   brain's last fetch. `ls-remote` queries the remote directly regardless of
   local clone state. Check the exit status and retain only full refs with
   this brain's exact prefix. A failed/unavailable query is **unknown, not zero
   refs**: omit `rescueBranches`, record the failure/blocker in markdown and
   JSON `observations`, and do not submit age-based feedback from that failed
   query or a previous report. Preserve the escalation ledger unchanged and
   continue other maintenance where existing guards permit.
2. After a successful query, populate `rescueBranches` in the JSON report,
   including when no matches are found:

   ```json
   "rescueBranches": {
     "count": <number of matching refs>,
     "oldestAgeDays": <maximum valid ageDays; null if count is 0 or any
       matching timestamp is uncertain>,
     "refs": [<matching ref names, e.g.
       "refs/heads/conflict/01K...-1788300000">]
   }
   ```

   `<timestamp>` is **unix seconds** (not milliseconds) — matches how
   `teamvibeai/teamvibe.ai#247`'s `pushRescueRef` names the ref on the
   platform side. Capture `nowUnixSeconds` once for this query. For **each ref**,
   parse the suffix after the exact own-brain prefix as nonnegative integer
   Unix seconds and compute
   `ageDays = floor((nowUnixSeconds - refUnixSeconds) / 86400)`.
   Malformed, unrepresentable, or future timestamps are age uncertainty:
   retain those refs in `count`/`refs`, set `oldestAgeDays` to `null`, and
   describe the uncertainty in markdown and JSON `observations`. Do not guess,
   clamp, or fabricate an age-based alert for those refs. Other valid own refs
   still receive their individual evaluation.

3. **Escalate each eligible ref (required).** For every valid own ref with
   `ageDays >= 7`, consult the durable ledger below and submit feedback if its
   state permits a new attempt (no prior entry, or a retryable rejection).
   Evaluate every ref independently: a previously escalated oldest ref must
   not hide a second ref crossing seven days. Use
   `submit_feedback` with `type: "improvement"`, `priority: "medium"`, and a
   `context` beginning with the stable identifier
   `rescue-ref:<compact JSON-encoded [workspaceId, brainId, fullRef]>` (no
   whitespace between elements). Use that same identifier for all attempts and
   reconciliation of this ref. Follow it with:

   - workspace, channel, and brain identity;
   - repository identity (owner/name or credential-free origin URL), and full ref;
   - creation time from the ref (Unix seconds and UTC), query time, and `ageDays`;
   - this cycle's planned markdown report path
     (`reports/YYYY-MM-DD-memory-consolidation.md`, completed later this cycle);
   - a request for central feedback triage to assign a **named human triage
     owner** and record an explicit **retain / reconcile / discard** decision.

   Do not invent an assignee or assume the feedback API assigns one. This runs
   at consolidation time, so seven days is an eligibility threshold, not a
   guaranteed notification deadline when maintenance is skipped or interrupted.
4. **Persist per-ref delivery state.** Maintain
   `memory/rescue-ref-escalations.md`, keyed by the exact tuple
   `(workspaceId, brainId, fullRef)` above. Store identity, creation/query time,
   observed age, report path, attempt time, submission status, and any returned
   receipt/feedback ID or response evidence. Retain attempt outcomes and any
   reconciliation evidence. Consult it every cycle; never use the previous JSON
   report as the ledger because reports may be consumed/deleted. **Preserve all
   entries and receipts across memory trimming and archival**, including when
   a ref disappears; do not reset suppression by summarizing or moving entries
   out of this lookup path. An unreadable or conflicting ledger blocks new
   submissions until reconciled; report the blocker.

   Apply the consolidation skill's **Checkpoint Rules** to ledger writes, using
   `consolidation-commit.sh` with the cycle's original date and boundaries such
   as `rescue escalation attempt` and `rescue escalation result`. Add the ledger
   to cumulative `filesChanged` whenever changed.

   - **Before calling the API**, write status `attempting` with the exact
     context and attempt time, then checkpoint it successfully. If persistence
     fails or a guard blocks the checkpoint, do not submit.
   - **Immediately after the call**, persist and checkpoint the result with
     returned receipt/ID if any (never invent one). A positive acknowledgement
     confirms `submitted`; retain its response evidence even if no ID is
     returned. **Confirmed success suppresses repeat submissions** for that
     key while detection/reporting continues each cycle.
   - A definite rejection that confirms non-acceptance becomes `rejected`, with
     the reason. It is retryable at a later consolidation after the cause is
     addressed, using the same identifier and a new persisted attempt; do not
     retry in a loop this cycle.
   - Timeout, crash during submission, lost acknowledgement/receipt, or an
     `attempting` entry left by interruption means `uncertain`. Do not assume
     failure or resubmit. Reconcile through central feedback triage using the
     stable identifier; record its evidence/receipt before marking `submitted`,
     or confirmed non-acceptance before allowing a later retry. If reconciliation
     is unavailable, keep it blocked and report that fact. If the API succeeds
     but the result checkpoint fails, preserve available evidence and treat the
     durable attempt as uncertain on recovery.

   Local bookkeeping **does not guarantee exactly-once delivery** across
   concurrent clones or remote-success/local-write crashes. The current client
   exposes neither server idempotency keys nor feedback lookup; stronger
   guarantees require a separate API change. Do not invent a lookup endpoint.
5. **Report outcomes; do not resolve automatically.** Record per-ref eligibility,
   submission/suppression/rejection/uncertainty, receipts, and blockers in the
   markdown report. Reuse JSON `decisions`, `observations`, `recommendations`,
   and `processImprovements` as appropriate (respect their brevity limits); no
   new report fields are needed. Escalation is required, but do not merge,
   cherry-pick, fast-forward, or delete rescue refs/content during these steps.
   A triage request permits no automatic resolution.
6. **Cleanup convention:** whoever separately resolves a rescue branch (merges
   it back, or confirms its content is safe to discard) is responsible for deleting
   the ref afterward (`git push origin --delete conflict/<brainId>-<timestamp>`).
   Nothing in detection/escalation deletes it automatically.
7. **Scope:** only this brain's own `<brainId>` prefix — never another
   brain's. Channel brain repos are private and distributed across customer
   GH orgs with no cross-brain repo read path (see CLAUDE.md "Channel Brain
   Isolation"); `rescueBranches` is one signal among others the eval
   pipeline aggregates into a fleet-wide "outstanding rescue branches"
   metric (count + oldest age). Own-brain escalation is required independently
   of fleet aggregation. Follow the Reporting Convention; no unsolicited
   Slack summary is needed.
