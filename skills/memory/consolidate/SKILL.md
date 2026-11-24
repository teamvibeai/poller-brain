---
name: memory-consolidate
description: |
  Memory consolidation skill. Run during maintenance heartbeat to process daily
  logs into long-term memory. Should be invoked when the newest
  reports/*-memory-consolidation.md is 1+ days old or missing.
---

# Memory Consolidation

Process recent daily logs and promote important information to long-term memory.

Before using the MEM trim scripts on a fresh checkout or after their dependencies
change, run `npm ci --prefix "$CLAUDE_CONFIG_DIR/skills/memory" --ignore-scripts`.
Their CommonMark parser and locked installation are documented in [../README.md](../README.md).

## When to Run

First run the Pre-Step-0 state check below. An unfinished cycle stops the run:
inspect it and use the explicit `repair` command (never resume automatically);
inspect unknown history before applying cadence. Once the state is definitive, check
the newest `reports/*-memory-consolidation.md` filename for the date of
last consolidation (`poller-brain#346` — this is the authoritative source, not
the gitignored `memory/.last_consolidation` marker, which only tracks when a
report was POSTed and can lag behind or be absent after a re-clone).
If it's 1+ days old or missing, run consolidation.

## Algorithm

**All steps below are mandatory on every consolidation run.** There is no "lightweight" or "partial" mode. Even when daily logs are empty or steps 2–4 produce zero promotions, Step 6 (Regenerate SUMMARY.md) MUST still execute. Never skip or abbreviate steps because a run "has nothing to process." **Narrow exception (#466):** only the reduction candidate searches in Step 6 and Step 9c may be deferred under the per-file retry contract below. Regeneration, validation, metrics, integrity audits, checkpoints, and reporting remain mandatory.

### Per-file reduction retry contract (#466)

This is per brain and independently per target: `memory/SUMMARY.md` (Step 6, 9000 B) and `CLAUDE.md` (Step 9c, 10000 B). It does not schedule maintenance, override `MAINTENANCE_DISABLED`/idle cadence, or authorize resuming an interrupted cycle. Run the existing whole-run and Pre-Step-0 completion/repair guards first. Use this invocation's recorded **pre-Step-0/session-start HEAD** (the marker's starting HEAD when maintenance already started this same invocation) for `START_HEAD` below; never substitute a checkpoint, draft, or an older convenient final.

After required regeneration/validation, immediately before each over-cap target's candidate search, run the read-only helper from the brain root:

```bash
node "$CLAUDE_CONFIG_DIR/scripts/consolidation-retry.mjs" . memory/SUMMARY.md --completed-at "$START_HEAD" --coverage-confirmed
node "$CLAUDE_CONFIG_DIR/scripts/consolidation-retry.mjs" . CLAUDE.md --completed-at "$START_HEAD" --coverage-confirmed
```

Use `--coverage-confirmed` only after verifying the helper's inventory covers all decision inputs: both target files; the entire `memory/` file/availability inventory (including root registry/index files and every source tier); and the installed base CLAUDE, memory/consolidation skills, maintenance policy and helper. Generated `memory/TODAY.md`, `memory/.last_consolidation`, and `memory/episodic/consolidation-progress-YYYY-MM-DD.md` ledgers/markers are bookkeeping, **never reduction sources**, and excluded from the inventory. Supply repeatable `--dependency PATH` for any other relevant input (including external/imported/referenced sources, custom policies, or candidate directories); directories are inventoried recursively and missing paths fingerprint availability. Confirm the same complete dependency set at each attempt/decision. If coverage or normalization is uncertain, omit `--coverage-confirmed` and perform the normal search. Add `--review` whenever an explicit human request to reconsider that target is pending; do not treat a standing human-review warning as a new request every day.

**Daily maintenance filter:** Only direct `memory/daily/YYYY-MM-DD.md` archives may exclude exact complete lines `- HH:MM — <message>` or `- [HH:MM] <message>` with a valid 24-hour time and one of three messages: `memory consolidation started`, `memory consolidation completed`, `maintenance: consolidation session`. The filter requires plain, single-line top-level bullets under exact `# YYYY-MM-DD` headers matching the valid filename date. Sections containing only these maintenance lines are omitted together with their blank lines/date headers; a wholly maintenance-only file (and a daily directory with no remaining inputs) contributes no availability change. In mixed sections only the exact maintenance lines are removed; all other bytes remain inputs. Unknown messages, extra detail, MEM/REMEMBER tags, malformed times and incomplete lines stay source content. Ambiguous structure (including continuations, code/HTML context, mismatched headers or invalid UTF-8) means **search**, never silent deferral. Other paths and explicit extra dependencies are not filtered. No mtime heuristic is used. This lets Step 0 archive routine stubs and the required maintenance session entry without resetting a weekly stall; any substantive daily change still invalidates it.

**Consolidation history filter:** Only exact `memory/episodic/archive/consolidation-history-YYYY-Hn.md` paths may omit Step 6's bounded in-progress records. The retry helper uses the same append schema as `consolidation-history.mjs`, checks the date's bucket and starting HEAD ancestry, and preserves every legacy prefix byte. It verifies each append against its starting Git tree and its first committed bytes; later commits cannot rewrite or remove it, even while preserving the schema. An uncommitted append additionally requires the matching durable marker. A new archive containing only verified records, and its otherwise empty `episodic/archive/` and `episodic/` directories, adds no source availability. Invalid UTF-8, malformed/duplicate records, changed older bytes, removed archives, or unverifiable/merged/shallow append history means **search**. Explicit extra dependencies stay opaque. The schema and marker helper are fingerprinted as policy inputs. No mtime heuristic is used. Thus Step 6's required append preserves both targets' retry fingerprints whether their attempt preceded or followed the append; substantive source changes still invalidate backoff.

The helper reads only the **newest exact completed final commit's markdown at START_HEAD**. It requires the matching committed markdown/JSON pair in that final or its preceding `steps 10-12` checkpoint, with unchanged final markdown. It never reads working report drafts or consumed on-disk JSON and never falls back to an older stall when the newest report lacks valid metadata. Missing/corrupt/incompatible/future attempt metadata, merged/shallow/unverifiable history, uncertain inputs, or a helper failure means **search**, subject to the completion/repair guard (which still stops unfinished/unknown cycles). Helper advice cannot authorize starting or repairing a cycle.

- **`search`:** run the existing protected/bounded reduction algorithm. Fingerprints include file content (equal-byte-size edits count), source availability/content, target threshold, and reduction policy/version. Only SUMMARY's well-formed first `Last consolidated` line is excluded; no other target text is normalized. New source material may invalidate a stall even if unrelated; prefer safety over cache hits.
- **`deferred`:** skip only this target's candidate search. Carry the returned `entry` forward exactly, including its original `lastAttemptAt`, `nextEligibleAt`, `inputFingerprint`, `policyVersion`, and review reason. Do not recompute a deadline from today's report. Record `deferred: structural stall; next eligible <nextEligibleAt>; last actual search <lastAttemptAt>` and `structurally stalled, needs human review`, with current measured bytes/overage and a link to the helper's source report/commit. Do not claim a new attempt or repeat the old candidate narrative. Continue every other step.

**Establishing/clearing retry state:** Only a full, conclusive search of an oversized target with **zero successful reductions** that proves the entire remainder is protected or already pointer-only may establish `structurally-stalled` (`reason: protected-or-pointer-only`). One conclusive search suffices. Record the actual search completion time in UTC ISO format with milliseconds and set the deadline to exactly **168 elapsed hours** later. Capture the helper's non-null fingerprint at the actual attempt with complete dependencies. If inputs change during/after the attempt, establish a stall only if the conclusive proof covers those final inputs; otherwise clear it. Generic uncertainty, failed preservation/pointer checks, interrupted work, `no progress`, and `budget exhausted` cannot establish a stall. Any productive over-cap reduction retains normal next-run cadence, even if its remaining content appears protected. An under-cap result clears stale state without a candidate search. Each target's result stands alone.

**Durable evidence:** Include exactly one fenced `consolidation-retry-v1` JSON block under its own `## Reduction Retry Cadence` heading in every completed consolidation markdown report, with both target entries. Keep it outside `## Tier Coverage` and all other existing metric sections so their consumers retain the same input. Keep it in the in-progress ledger until reporting, but ledger/checkpoint-only metadata never grants deferral. Example shape (illustrative fingerprint):

````markdown
## Reduction Retry Cadence
```consolidation-retry-v1
{
  "version": 1,
  "targets": {
    "CLAUDE.md": {
      "status": "structurally-stalled",
      "reason": "protected-or-pointer-only",
      "lastAttemptAt": "2026-11-15T01:00:00.000Z",
      "nextEligibleAt": "2026-11-22T01:00:00.000Z",
      "inputFingerprint": "<64 lowercase SHA-256 hex characters from helper>",
      "policyVersion": "reduction-retry-v1",
      "reviewReason": "Only identity, imports and behavioral rules remain; needs human review"
    },
    "memory/SUMMARY.md": {
      "status": "under-cap",
      "reason": "under cap",
      "lastAttemptAt": null,
      "nextEligibleAt": null,
      "inputFingerprint": null,
      "policyVersion": "reduction-retry-v1",
      "reviewReason": null
    }
  }
}
```
````

For a deferred target use the helper's returned entry (`status: deferred`). For all other outcomes use `status: under-cap`, `progress`, `ambiguous`, `no-progress`, or `budget-exhausted` as appropriate, with an honest `reason`, null deadline/fingerprint/reviewReason, and the actual `lastAttemptAt` only when a search occurred (otherwise null). Never carry an old stall over successful progress or an under-cap result. At/after the unchanged deadline the first otherwise-authorized consolidation searches again; deferred runs do not slide it. Preserve the overage warning and review reason in `processImprovements`/report Consequences using existing fields; do not add JSON schema/self-assessment keys or send external messages automatically.

### Pre-Step-0. Verify Prior-Cycle Completion (mechanical citation guard)

Before resetting TODAY.md or writing any consolidation citation, record the session-start HEAD with `git rev-parse HEAD` (for Step 10), then run from the brain root:

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-state.sh" .
```

This read-only check inspects the durable start marker first, then finds the newest checkpoint, extracts its cycle date, and requires a later exact `chore: consolidate memory (YYYY-MM-DD)` final commit plus the matching markdown/JSON report pair in that final commit or its preceding Step 12a checkpoint. With a marker, its starting HEAD must be an ancestor of both the selected checkpoint (if present) and the final commit; merging another clone's same-date completion does not complete this cycle. The markdown must also exist on disk without uncommitted report edits. The JSON may have been consumed by the platform, so its committed copy is the evidence. A report on disk alone never proves completion.

- **Exit 1 / unfinished cycle:** stop and report the interrupted date, starting HEAD/checkpoint, and missing evidence. An unfinished marker always blocks a later invocation, regardless of its age or other metadata. Inspect existing work, then explicitly run `consolidation-marker.sh repair` using the audited procedure below. Do not repeat Step 0's archive/reset or retention deletions blindly. Checkpoint subjects identify a boundary, not proof that later steps ran. Audit SUMMARY.md and episodic history citations; remove or label unsupported claims as incomplete. Without a marker, inspect and reconcile unfinished checkpoint/report evidence manually before a fresh start.
- **Exit 2 / marker malformed/unreadable or history unavailable:** stop and report the uncertainty. Inspect available history and reports manually; do not assert completion from unverified citations. A shallow clone with no visible checkpoint is also uncertain. Maintenance returns non-zero with `consolidation_inspect: true`; do not start a fresh cycle or apply cadence until state is definitive. For a malformed/unreadable marker, use the explicit audited `repair` procedure below.
- **Exit 0:** no unfinished evidence was found, or the existing cycle's completion was verified. Still inspect `git status --short` and today's report together before starting. If a verified completed marker remains, run `clear` before starting a fresh cycle.

**Durable start (required before the first maintenance log/archive mutation):** For a fresh cycle that is due, run:

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" start .
```

Require exit 0 before writing the maintenance session log or entering Step 0. The helper atomically publishes a versioned marker (temporary file + rename) at `git rev-parse --git-path consolidation-start`, outside the index, containing the UTC cycle date and starting HEAD. It refuses to overwrite any existing marker or bypass unfinished/unknown state. The successful `start` authorizes this fresh cycle's uninterrupted execution. If MAINTENANCE.md just completed the prior-state check and successful `start` before logging in this same invocation, proceed directly to Step 0 using that date and HEAD. Do not rerun the prior-state check after starting. Any later invocation must run the check and stop on an unfinished marker; finding a marker never grants permission to continue writing.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" inspect .
```

Inspect is read-only: exit 0 means absent, 1 prints `v1 YYYY-MM-DD START_HEAD` (older v2 records remain readable; their extra metadata grants no authority), and 2 requires inspection. Use the cycle's original date and starting HEAD for checkpoints, reports and Step 10, including across UTC midnight. A marker with no checkpoint can mean Step 0 was partly or fully applied. A previous completed cycle, even on the same date, does not supersede the marker. A leftover lifecycle lock after a killed writer requires manual inspection; inspect/state perform no repair.

**Audited marker repair (the only path for an interrupted marker):** Repair is an explicit action after inspection, never called by the guard. It accepts valid unfinished markers as well as malformed/unreadable markers:

1. Capture current `inspect` output in a file (exit 1 or 2 is expected), for example `bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" inspect . > "$(git rev-parse --git-path consolidation-start).inspect.txt"`.
2. Inspect `git status --short`, checkpoint/final history, TODAY.md and daily archives, the progress ledger, report drafts, and committed markdown/JSON report evidence. Reconcile whether Step 0 or later writes already happened. Save review notes with non-empty lines `Archives inspected: <findings>` and `Reports inspected: <findings>` in a separate file in Git metadata. This is an attestation of the inspection; the helper validates its presence, not the correctness of the review.
3. Run `bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" repair . INSPECT_CAPTURE REVIEW_NOTES` (paths are relative to the brain root, or absolute). The helper locks lifecycle changes and requires the captured output to match current inspection and both review notes. It preserves the marker by moving it to a timestamped `consolidation-start.*.broken` path, saves the inspection/notes in the adjacent `.audit`, and logs request/completion in `consolidation-start.repair.log`.
4. Rerun state inspection and reconcile unfinished archives/reports before a new `start`. Repair changes no archive, report, index or commit and does not establish completion. Keep the backup and audit. Use `consolidation-marker.sh repair . INSPECT_CAPTURE REVIEW_NOTES` instead of manually removing or overwriting a marker.

#### Non-canonical final recovery

A final such as `chore: consolidate memory + reflection (YYYY-MM-DD)` does not match the required exact `chore: consolidate memory (YYYY-MM-DD)` subject. Follow [MAINTENANCE.md — Non-canonical final recovery](../../../MAINTENANCE.md#non-canonical-final-recovery) from the affected brain root, using the blocked cycle's original UTC date. This explicit audit is required before any recovery write; a marker alone never authorizes resuming the skill.

- Capture `consolidation-marker.sh inspect` output and review status, checkpoint/final lineage, TODAY.md/daily archives, progress ledger, required steps, report drafts, and committed report evidence. Save genuine findings with non-empty `Archives inspected:` and `Reports inspected:` lines in a separate Git-metadata file; reconcile unsupported completion citations.
- **Valid original marker, only canonical final missing:** only if all required steps actually finished, alarms are resolved, allowed-path changes are reviewed, and original date/starting HEAD, ancestry, history append and committed report metadata agree, run the read-only preflight below. Require the committed pair at HEAD or the exact Step 12a checkpoint, valid `consolidationHistory` v1 metadata, and markdown on disk without unfinished edits. Never recreate consumed JSON. Keep the original marker for validation; apply **Checkpoint Rules** before finalization.

  ```bash
  # Only after the audit above; final runs only if preflight succeeds:
  node "$CLAUDE_CONFIG_DIR/scripts/consolidation-history.mjs" . YYYY-MM-DD --final &&
    bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD final
  bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-state.sh" .
  ```

  The helper can create an empty canonical final when appropriate; this is not an unconditional empty-commit remedy. Require exit 0 and `consolidation_state: complete` before `bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" clear .`; clear rechecks and retains the marker on failure.
- **Marker present, finalization inapplicable/rejected:** stop on missing/conflicting history, metadata or ancestry, malformed markers, and incompatible legacy reports. State can recognize legacy evidence that the current final helper rejects; do not fabricate v1 metadata/history, bypass checks or force a final. If retiring the interrupted marker after review, use the audited repair procedure above: `bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" repair . INSPECT_CAPTURE REVIEW_NOTES`, with an existing marker, matching current capture and actual review notes. Keep the `.broken` backup, `.audit` and repair log. Recheck state; repair alone does not establish completion or bypass checkpoint/report evidence.
- **Marker absent:** manually reconcile checkpoint history, archives and reports. Do not run repair or create a replacement marker for the final helper, which requires a valid original marker. Preserve incompatible/legacy evidence for explicit review. Recheck state after reconciliation; there is nothing to clear, and `none` does not prove the old cycle complete.

Remain stopped on blocked/unknown state. Completion citations and clearing require verified `complete`; fresh starts still require the normal guard/start protocol. Never remove an unfinished marker manually or repeat archive/reset blindly.

**No forward completion citations:** Until the final commit and report pair are verified, SUMMARY.md/episodic history may describe this run only as "in progress" with existing checkpoint SHAs. Do not write "Commit: see chore: consolidate memory (YYYY-MM-DD)" or a completed-history report link before that evidence exists. Defer completion citations until after the final commit; commit any subsequent citation edits separately.

### Checkpoint Rules (apply to every checkpoint and the final commit)

**Never commit over an unresolved integrity alarm.** If Step 9d or any other step (including recovery of a prior cycle) raises an integrity alarm, stop and investigate under that step's guidance; do not commit a partial state or advance to the next step until resolved. This preserves Step 9g's exception at every new checkpoint as well as 6a and the final commit. Do not clear an alarm merely to make a checkpoint.

Before staging, inspect and reconcile unexpected local changes under the base-brain git-safety protocol. Use `consolidation-commit.sh` for every checkpoint/final commit below. It stages and commits only changed paths under `memory/` (including the Step 10a ledger and Step 5d/9e rejected-review state) and the cycle's exact report pair. Unrelated modified, untracked, and staged user files remain untouched, including their staged state. It never commits the deletion of a consumed JSON report. Never use repository-wide staging. If there are no consolidation changes, the helper skips intermediate commits silently; other commit failures must be investigated, never silently ignored. Use the cycle's original date in every checkpoint/final subject, including a cycle crossing midnight. Keep a cumulative `filesChanged` list across checkpoints; a clean tree does not erase earlier work from the report.

For reviewed outputs outside those default paths (Step 5 skill/guard promotion, Step 8 `HEARTBEAT.md`, Step 9c `CLAUDE.md`), append only the exact files this cycle changed to the helper command, for example `... "steps 8-9" HEARTBEAT.md CLAUDE.md`. Never pass a broad directory or unrelated user file. Inspect and reconcile pre-existing user changes within allowed paths before running the helper; the allowlist is not permission to include unrelated edits there.

### Mutation submission (Steps 1–5d and Step 7)

For **every memory mutation in Steps 1–5d and every Step 7 deletion**, submit a JSON manifest to the command below. All instructions in those steps to write, update, replace, remove, merge, split, archive, or register mean **prepare the desired content and submit it through this helper**, never edit the live memory files directly. Group related changes (e.g. registry + promotion, archive + pointer) into one request. **Narrow bookkeeping exception:** the Step 5d/9e rejection command atomically writes only `memory/.trim-review-state.json` through its validated helper; include that pending state in the next normal memory checkpoint. This exception permits no source/narrative mutation and grants no review suppression before the completed final/report pair. Each successful request has already committed its checkpoint; do not defer submission until Step 4a, 6a, or 7a. This includes Step 5d before entering Step 6.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-apply.sh" . YYYY-MM-DD "step 5d" < "$CONSOLIDATION_MANIFEST"
```

Use the original marker date and the exact step label (`step 1`, `step 1b`, `step 1c`, `step 2`, `step 3`, `step 4`, `step 5`, `step 5b`, `step 5c`, `step 5d`, or `step 7`). Save the manifest outside `memory/` (prefer a temporary file). Its schema is:

```json
{
  "version": 1,
  "baseline": "<full git rev-parse HEAD captured before planning>",
  "validation": { "alarms": [] },
  "mutations": [
    { "op": "write", "path": "memory/core/LEARNINGS.md", "before": "<SHA-256 of original file bytes>", "content": "<complete desired UTF-8 content>" },
    { "op": "delete", "path": "memory/semantic/obsolete.md", "before": "<SHA-256 of original file bytes>" }
  ]
}
```

For a new file, `before` is `null`. Record every unresolved integrity/validation alarm in `validation.alarms`; a missing validation result or nonempty alarm list blocks the transaction. This field attests to the step-specific checks above; the helper additionally checks paths, marker/date/ancestry, baseline content/index conflicts, and Git whitespace errors. Do not clear alarms to obtain a commit. Steps 1–5d allow Markdown files in `core/`, `semantic/`, `episodic/`, `procedural/`, `daily/`, plus `TODAY.md`, `MEM_REGISTRY.md`, and `MEM_REGISTRY_ARCHIVE.md`, all under `memory/`. Step 7 accepts only deletions of `memory/daily/YYYY-MM-DD.md` or `weekly-YYYY-MM-DD.md` older than 30 days relative to both the cycle date and current UTC date. Traversal, symlinks, hardlinked targets (`lstat.nlink > 1`), non-files, and paths outside the allowlist fail closed. Writes and rollback restores use a new temporary file in the target directory followed by rename; they never overwrite an existing inode.

The helper uses the strict exact-path mode of `consolidation-commit.sh` (`--memory-only BRAIN_DIR YYYY-MM-DD BOUNDARY EXACT_MEMORY_PATH...`). It preserves unrelated staged and working changes, including other memory files, and never pushes. Target files must match committed baseline bytes and have no staged changes. A stale baseline is rejected except for an unchanged, already-committed retry, which leaves HEAD unchanged. Require exit 0 and verify the promoted content before continuing. On failure, stop and inspect; do not bypass the helper or automatically recover/restart. The start marker remains until final completion is verified and explicitly cleared by the existing completion step.

Every transaction Git command disables all Git hooks, including `post-index-change` and `post-commit`. After committing, the helper checks every target's working bytes against its committed blob, checks each blob against the manifest's requested bytes (or the captured working bytes in strict memory-only mode), and checks the prepared index for staged target changes before atomically publishing that index. It reports success only after scratch and lock cleanup succeeds. It constructs the exact transaction commit ID in advance. On synchronous failure it restores the baseline only if HEAD is that exact transaction commit (or is already the baseline). Any other HEAD or rollback ref conflict stops with `no rollback; operator repair required`: it preserves HEAD, working files, the real index, marker, lifecycle/index locks, and the `consolidation-index-*` directory named in the error. Do not rerun the transaction or reset HEAD to the baseline.

**Operator repair after unexpected HEAD:** Verify the writer has exited. Save the error (baseline and transaction IDs), current HEAD/reflog, `git status --short`, staged/unstaged diffs, target file bytes, and copies of the marker, real index, both locks, and named scratch directory outside the worktree. Resolve Git metadata paths with `git rev-parse --git-path`; linked worktrees have their own paths. Inspect the independent commit and transaction object with `git show` and reconcile their changes with the preserved working files and index, retaining independent work. After the audit and reconciliation, remove only the confirmed abandoned index/lifecycle locks and scratch directory whose evidence was saved. Run marker `inspect` again, capture its output, and use the audited `consolidation-marker.sh repair` procedure above with archive/report review notes. Repair does not reconcile commits or files; that operator work must precede a fresh state check and `start`.

### 0. Archive TODAY.md

Require the durable start marker above before any write, including creating a missing TODAY.md. Before processing, archive `memory/TODAY.md` to the daily/ directory:

1. Read `memory/TODAY.md` — extract the date header(s) (format: `# YYYY-MM-DD`)
2. For each date section in TODAY.md:
   - Append its content **verbatim** to `memory/daily/YYYY-MM-DD.md` (create if needed). Copy every bullet point and line exactly as written — do NOT summarize, truncate, rephrase, or condense entries. The daily archive must be a byte-for-byte copy of the original content.
   - **⚠️ Multiple date sections → multiple files (required).** If TODAY.md contains sections `# 2026-05-15`, `# 2026-05-16`, `# 2026-05-17`, you MUST create three separate files: `daily/2026-05-15.md`, `daily/2026-05-16.md`, `daily/2026-05-17.md`. Do NOT archive all sections into a single file — that silently fails `daily-log-weekly-coverage` because only the first date gets a log file while all other session days are invisible to the evaluator.
   - If TODAY.md has entries but no date header at all, assign them to today's date and archive to `memory/daily/<today>.md`.
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

### 0a. Checkpoint Commit (crash-safety)

**Commit immediately after Step 0, before any Step 1–6 work.** Protect the TODAY.md reset and verbatim daily archives (#474). Apply **Checkpoint Rules** first: stop on any unresolved integrity alarm; reconcile unexpected changes; skip silently only if the allowed consolidation paths have no changes.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD "step 0"
```

### 1. Scan Daily Logs

Read all files in `memory/daily/` dated since the last consolidation date
(the date parsed from the newest `reports/*-memory-consolidation.md`
filename, per "When to Run" above — not `memory/.last_consolidation`).
If no matching report exists, process the last 14 days of logs.

### 1b. Process `[MEM-NNN]` Tracked Keys (priority)

**Before** extracting general facts, scan all daily logs from step 1 for lines containing either accepted ID format (`[MEM-<n>]` or `[MEM-YYYY-MM-DD-HHMMSS-<uuid>]`), malformed `[MEM-…]` tags, or `[REMEMBER]` (backward compat). These are tracked memory entries and must be promoted with **guaranteed priority** — they are never filtered by heuristics.

> **⚠️ Anti-pattern: auto-memory is NOT persistent memory.**
> Claude Code's built-in auto-memory (`~/.claude/projects/.../memory/`) is ephemeral — it does not survive re-clones, machine changes, or container restarts. NEVER treat auto-memory as a substitute for writing to the brain's `memory/` tier files. `[MEM-NNN]` items MUST be physically written to `memory/core/` or `memory/semantic/` files. Claiming "already captured in auto-memory" is NOT valid — auto-memory is provider-specific and not part of our memory model.

#### Auto-fix malformed keys

Validate IDs with `scripts/lib/mem-id.ts` (`isMemId`): readers accept legacy `MEM-<n>` and dated `MEM-YYYY-MM-DD-HHMMSS-<uuid>` (full 8-4-4-4-12 hex UUID, either hex case; syntactic validation only). Preserve the exact spelling. **Never repair or renumber an ID that `isMemId` accepts**, including one carrying the lifecycle suffix `:obsolete` (validate the ID before the suffix).

If a `[MEM-…]` tag fails that validation (e.g., `[MEM-feedback]`, `[MEM-TAG]`):
1. Allocate an ID with `npx tsx $CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-id-new.ts`; preserve its exact stdout ID for this memo
2. Replace the malformed tag in the daily log with `[<allocated ID>]`
3. Register that exact allocated ID with status `ACTIVE`
4. Log the fix in the report: "Auto-fixed malformed key: [MEM-feedback] → [<allocated ID>]"
5. Process as a normal `[MEM-NNN]` entry

#### Handling `[REMEMBER]` backward compatibility

If a `[REMEMBER]` tag is found (without a `[MEM-NNN]` key):
1. Allocate an ID with `npx tsx $CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-id-new.ts`; preserve its exact stdout ID for this memo
2. Replace `[REMEMBER]` with `[<allocated ID>]` and register that exact ID with status `ACTIVE`
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

4. **Submit** the destination content and any registry/daily-log edits through `consolidation-apply.sh` with `step 1b`. Require checkpoint success. The `[MEM-NNN]` key MUST be preserved in the promoted entry:
   ```markdown
   # In core/LEARNINGS.md:
   - [MEM-3] Deploy flow: main = STAGING only, produkce = version tag (v0.0.X)...
   ```

5. **Verify promotion landed** — after writing, grep the target file for a key phrase from the promoted entry. If the grep returns no match, the write failed — retry or flag as an error in the report. Do not proceed to the next item until verification passes.

6. **Report tracking:** Add each promoted `[MEM-NNN]` item to the markdown report under a `## [MEM] Promotions` section, listing: key, original entry, destination file, action taken (ADD/UPDATE/NOOP), verification result (VERIFIED/FAILED).

If no `[MEM-NNN]` or `[REMEMBER]` tags are found, skip this step and note "no [MEM] tags found" in the report.

### 1c. MEM Lifecycle — Obsolescence Check

Review entries in `memory/MEM_REGISTRY.md` with status `ACTIVE`:

Submit each related registry/content lifecycle change together through `consolidation-apply.sh` with `step 1c`; never write the live files directly.

1. **Check for contradictions** — if newer daily log entries contradict or supersede an existing ACTIVE entry, mark it `OBSOLETE`:
   - Update registry: status → `OBSOLETE`, set obsoleted date
   - Update the content file: append `:obsolete` to the existing ID in either format, e.g. change `[MEM-N]` to `[MEM-N:obsolete]`; never renumber it
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

Prepare the destination content below, then submit it through `consolidation-apply.sh` with `step 4`. Require checkpoint success for every promotion before continuing.

| Type | Destination |
|------|-------------|
| Team/project facts | `memory/semantic/{topic}.md` |
| Significant events | `memory/episodic/{event-name}.md` |
| Workflows/procedures | `memory/procedural/{process-name}.md` |
| Preferences | `memory/core/PREFERENCES.md` |
| Lessons | `memory/core/LEARNINGS.md` |
| Mistakes | `memory/core/MISTAKES.md` |

### 4a. Checkpoint Commit (crash-safety)

**Before Step 5**, verify that every Steps 1–4 memory mutation was submitted through `consolidation-apply.sh` and returned success. Those writes already have structural checkpoints (#458). Stop on an unresolved alarm or unsubmitted memory change. Use the scoped helper below for any pending report changes, applying **Checkpoint Rules** first.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD "steps 1-4"
```

### 5. Promote Mistakes

Review `memory/core/MISTAKES.md` for entries ready to be promoted. For each entry with status `new`:

1. **Determine the promotion path:**
   - Is the mistake specific to a skill/tool? → Add a pitfall to the relevant `skills/*/SKILL.md` file (create a `## Pitfalls` section if needed)
   - Is it a general operational rule? → Extract the lesson to `memory/core/LEARNINGS.md`
   - Is it critical enough for automated prevention? → Create a guard (file check, validation step) and document it in `memory/procedural/`

2. **Execute the promotion:**
   - For memory destinations, submit the promoted content and the MISTAKES.md status `promoted → {destination}` together through `consolidation-apply.sh` with `step 5`.
   - For skill/guard destinations outside memory, prepare and verify the exact output first and checkpoint it under **Checkpoint Rules** using the exact extra path. Only after that succeeds, submit the memory status change through `consolidation-apply.sh`; its allowlist never permits skill/script writes.

3. **Clean up previously promoted entries:**
   - Remove entries that were marked `promoted` in the *previous* consolidation run (they've been visible for one cycle)
   - Keep entries marked `promoted` during *this* run (so the promotion is visible next cycle)

If MISTAKES.md has no entries or doesn't exist, skip this step.

**Report tracking:** Add any promoted-to files to `filesChanged`. Add a summary of promotions (or "no mistakes to promote") to the markdown report.

### 5b. Semantic File Lifecycle

Scan `memory/semantic/` for stale, oversized, or redundant files. This step keeps semantic memory clean and navigable — without it, old files accumulate noise that degrades search quality.

**Run this step before Step 6 (Regenerate SUMMARY.md).** For a split, prepare destinations and live-pointer changes here; if SUMMARY still needs the original, retain its unchanged content until the cutover after Step 6a described below.

Submit UPDATE/DELETE/MERGE/split results within the **Mutation submission** allowlist (including TODAY.md and registry pointer edits) through `consolidation-apply.sh` with `step 5b`. Group related writes and deletions into one manifest and require checkpoint success. The split runbook below governs changes outside that allowlist and any deferred retirement.

#### Staleness Detection

For each file in `memory/semantic/`:

1. **Check last modification** — run `git log -1 --format=%ai -- <file>` to get the last commit date touching that file.
2. **Shallow clone guard** — if `git log` returns empty (no history available, common in shallow clones after re-clone), treat the file as stale and flag it for review. Do NOT auto-delete files with missing history — only flag them for manual assessment.
3. **Flag as stale** if not modified in 30+ days (or if history is missing per step 2).

#### Actions on Stale Files

For each stale file, assess its content against current knowledge:

| Condition | Action |
|-----------|--------|
| Content is still accurate and useful | **KEEP** — no change needed (reset staleness by noting "reviewed YYYY-MM-DD" in the report) |
| Content is partially outdated | **UPDATE** — refresh outdated sections in-place, preserve accurate parts |
| Content is fully outdated or superseded | **DELETE** — remove the file entirely |
| Content overlaps significantly with another semantic file | **MERGE** — combine into one file, delete the redundant one |

**Conservative approach:** When unsure whether content is still relevant, KEEP it. Only DELETE when the information is clearly wrong or obsolete. Prefer UPDATE over DELETE.

**Never discard ACTIVE MEM content.** Obsolete content must first go through the MEM lifecycle (Step 1c). A lossless split may retire the original only after the runbook verifies every section and MEM key at its new location, with registry status unchanged. This applies to both legacy and dated MEM IDs.

#### Size Check

For all files in `memory/semantic/` (not just stale ones):

Count lines with `wc -l`. **Over 100 lines is a review trigger, not a hard cap or an instruction to delete content.** Split only clearly distinct sub-topics; a 120-line cohesive topic can remain intact with a recorded reason. Choose leaf files with descriptive names and record their size goals and any cohesive-topic exceptions. A roughly 250-line destination goal still requires review above 100 lines; it does not replace that trigger. For example, 671 lines cannot fit losslessly into two files each below 250 lines: use additional leaf files within the themes or justify a revised goal. Never drop or condense content merely to meet a size target.

#### Citation-safe split runbook

Use this runbook for semantic splits, including ones first identified by reflection. Topic partitioning is a semantic judgment; neither a filename search nor the MEM citation detector proves a safe migration.

1. **Bound the work and select at most one source file per cycle.** Read prior Semantic Lifecycle reports and existing split handoffs first. Prioritize an existing due task over a fresh candidate; carry its task identity and original deadline forward. Fix a time/change budget before planning. List other candidates as queued, not completed splits. For the selected source, finish with exactly one outcome: `migrated`, `justified no-split`, or `concrete handoff`. If nothing warrants splitting (including an empty directory), record `justified no-split` with the measured reason. Complexity, budget exhaustion, or unavailable review requires a handoff, not a no-split justification.

2. **Capture a fresh origin-repo baseline and inventory readers.** Inspect HEAD, index and working changes under **Checkpoint Rules**; isolate unrelated work. Record the full origin revision, source path, SHA-256 of exact source bytes, line/byte counts, and hashes of inbound files. Inventory complete section spans, including nested headings, preamble/trailing text, explicit section numbers, MEM keys, and outbound/internal links. Search the whole origin repository, not only `memory/`: include all memory tiers, `memory/SUMMARY.md`, registry rows, `kb/`, docs and reports, including relevant hidden/ignored or untracked files. Exclude Git metadata and generated dependencies explicitly; record search coverage and exclusions.

   Search both full/relative path variants and basename, then inspect each occurrence for bare paths, Markdown links (including reference-style links), `:line`/line ranges, `#L…`/`#L…-L…`, heading anchors and section-number references. Search heading names/numbers and aliases too so shorthand references are not missed. Distinguish live navigation from examples, immutable revision links and historical quotations; resolve ambiguous matches by reading the surrounding content. Record each occurrence's reader path/location, syntax, classification/reason, intended source content, and proposed destination/selector. Count reference occurrences separately from distinct referring files. Include existing destination readers if inserting text or editing pointers shifts their cited lines; expand the affected set until all affected references are accounted for.

3. **Map complete sections before writing.** Save a partition plan and old-section/line-range → new-path/section/line-range map in a durable origin-repo file (for memory-only work, e.g. `memory/procedural/semantic-split-<source>.md`). Include the original revision and source hash so historical citations can be looked up later. Assign every source span exactly once, retaining parent/nested-heading context without overlapping or omitting content. Preserve section text, heading/section identifiers, MEM keys, status, provenance and links; do not renumber sections or reissue IDs. Record any necessary relative-link rebasing or fragment change explicitly and verify it still reaches the same content. Cross-section links may need new file paths. Prefer stable section identifiers for new references where readers support them; retain numeric selectors where required.

4. **Prepare and validate the complete affected set in scratch.** Prepare destinations, every live-pointer update, registry locations and the relocation map together. Compare every original span and MEM key with the final files: no lost text, duplicate moves or missing ACTIVE content. Validate each live reference against its recorded intended content using the final bytes, not just an existing file or an in-range line. Recalculate numeric pointers after all edits; check range endpoints, nested/duplicate-heading anchor behavior in the actual reader, section-number meaning, and outbound/relative/internal links from each new directory. Ambiguous targets block retirement. Rescan for old references and give every remaining occurrence an explicit disposition.

   Recheck HEAD and source/inbound/destination hashes immediately before applying. Any unplanned source or reader change, including a new inbound reference, invalidates the plan: refresh the inventory and validation instead of applying stale offsets. Rebaseline only after inspecting expected checkpoints in a staged cutover. An empty `validation.alarms` attests to these checks; the helper does **not** perform content-equivalence or citation checks.

5. **Apply within the correct transaction boundary.** For allowlisted memory outputs, use `consolidation-apply.sh` with `step 5b`, baseline hashes and the complete grouped manifest. Include the durable plan/map and affected TODAY/registry/tier pointers; order destination writes before reader updates and source deletion last. Never broaden the helper's allowlist or bypass it with a second memory writer. `kb/` or other live-reader edits outside the allowlist (apart from SUMMARY's Step 6 path) require a **dedicated reviewed origin-repo change covering the complete affected set**; hand off that migration and keep the original content intact until that change is ready. This shared-repo workflow change does not repair a deployed origin file.

   Regenerate SUMMARY through **Step 6**, never through the apply helper. If SUMMARY still cites the source, first publish validated destinations and allowlisted pointer updates while retaining the **unchanged original content**, recording this temporary exception to retirement in the plan. Step 6 must use the map to move SUMMARY's live references to the destinations and omit the retained original from the new index. After the Step 6a checkpoint succeeds, recheck the complete inventory and final bytes; retire the original and finalize the map through a fresh `step 5b` manifest/checkpoint. If no live SUMMARY reference depends on the source, retirement may be grouped with the initial move. Validate every live reader again after application and SUMMARY regeneration before reporting `migrated`.

   Every intermediate state must keep existing references valid. A short index at the old path can preserve path-only navigation, but cannot preserve old `:line`/`#L` selectors or section anchors by itself. Retain the unchanged original until all such references have validated dispositions. An optional temporary index needs a named owner, retirement deadline and documented reason; unresolved retirement means `concrete handoff`. Keep **append-only past reports unchanged**: preserve their historical lookup via the original source revision and durable relocation map rather than rewriting their citations.

   Grouping is not whole-batch filesystem atomicity: individual renames do not prevent interruption between files. On failure or interruption, stop under **Mutation submission** / **Pre-Step-0** inspection and repair rules; preserve marker, baseline and checkpoint evidence, and record the exact applied boundary and remaining work. Do not auto-retry, leave an undocumented mixed migration, or call a scan, scratch validation or partial cutover a completed split.

6. **Record the outcome and carry unfinished work forward.** Link the durable inventory/plan/map from the current report. A `migrated` outcome requires committed destinations, validated live references, SUMMARY regeneration, and source retirement. `justified no-split` requires measured sizes and a content/cohesion rationale, not "defer again". A `concrete handoff` must name a stable task/path, source fingerprint (origin revision + path + SHA-256), inventory, partition/validation plan, responsible owner, explicit UTC deadline, blocker, next action and any applied checkpoints. If no separate assignee is available, name the responsible brain/maintainer; do not imply another person accepted the task. Retain the same task and overdue history when replanning; do not reset the deadline to hide a missed one. Record an overdue handoff as `[blocked]` for its owner to resolve in the report; reflection Step 4 escalates it using the lifecycle review. Escalation follows MAINTENANCE.md's reporting channel, without an unsolicited message.

#### Merge Detection

When processing stale files, also check for merge candidates among non-stale files:
- Two or more files under 20 lines covering the same topic → merge into one
- Files with nearly identical names or overlapping content → merge

#### Report Tracking

Add a `## Semantic Lifecycle` section to the markdown report:

```markdown
## Semantic Lifecycle
- Files scanned: 8
- Stale (30+ days): 3 (1 via shallow clone fallback)
- Actions: 1 KEEP (reviewed), 1 UPDATE (refreshed), 1 DELETE (obsolete)
- Oversized (>100 lines): 2 reviewed; 1 selected, 1 queued
- Split outcome: migrated — semantic/old-topic.md → semantic/topic-a.md + semantic/topic-b.md
- Sizes (lines / bytes): source 180 / 6400 → topic-a 90 / 3200, topic-b 90 / 3200
- References: 7 live occurrences in 4 referring files; 2 historical occurrences retained
- Validation: all source spans/MEM keys preserved; every live selector reaches intended content
- Inventory / relocation map: memory/procedural/semantic-split-old-topic.md (includes original revision/hash)
- Exceptions / remaining work: none
- Merges: 0
- Files changed: semantic/old-topic.md (deleted), semantic/architecture.md (updated)
```

Record the selected source's explicit outcome and supporting evidence using the runbook above; for a handoff include its owner, deadline and blocker. For no selection, record the justified no-split reason; keep queued files distinct from that outcome. Include original/final sizes, destinations, reference-occurrence and referring-file counts, exceptions and remaining work when a split is attempted. Add all created, updated, or deleted files (including reader edits and the plan/map) to `filesChanged`. Summarize the outcome/task in the existing JSON `decisions` field within its brevity cap; no new JSON/evaluator fields. Set `selfAssessment["semantic-lifecycle-checked"]` to `true` only for a completed scan and recorded outcome; this does not assert that a split completed.

If `memory/semantic/` doesn't exist or is empty, record `justified no-split — no semantic files` and set `selfAssessment["semantic-lifecycle-checked"]` to `true` (nothing to check).

### 5c. LEARNINGS.md Gradual Reduction

If `memory/core/LEARNINGS.md` exceeds its threshold, perform **one** small archival per consolidation cycle. This mirrors Step 9c (CLAUDE.md reduction) but for lessons memory — without this step, LEARNINGS.md grows monotonically because promotion appends new entries but never retires resolved or superseded ones.

**Preflight:** Run `npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-scaled-threshold.ts" --mode learnings` (see Step 9b's "Scaled thresholds" note — `teamvibeai/poller-brain#324`). If `overCap` is false, skip this step entirely. If true, proceed.

1. **Identify one archival candidate** (1–3 oldest entries) in `LEARNINGS.md` that meets ANY of:
   - **(a)** Has a `[MEM-NNN]` key whose status in `memory/MEM_REGISTRY.md` is `OBSOLETE` or `REMOVED` (i.e., the lesson has already been superseded via the MEM lifecycle in Step 1c)
   - **(b)** Describes an incident/problem that has a follow-up "resolved" or "shipped" entry visible in `memory/episodic/` (i.e., the underlying incident is closed), regardless of whether the key is still `ACTIVE` — a rule can remain currently valid (hence `ACTIVE` forever) even after the specific incident that taught it is long resolved. `teamvibeai/poller-brain#335`: an earlier version of this step banned archiving any `ACTIVE` key outright, which made criterion (b) unreachable by construction on any brain whose lifecycle doesn't retire keys to `OBSOLETE` — see the archival mode split below for how ACTIVE-key entries are handled instead of being excluded.

   **Never archive** an entry without a `[MEM-NNN]` key, or an entry younger than 30 days.

2. **Archive it** — the mechanism differs by registry status. This is NOT about Step 9a integrity (a verbatim copy in `episodic/archive/` satisfies Step 9a's presence check either way — full removal included). It's about **discoverability**: an `ACTIVE` key is a rule that's still in force, and `LEARNINGS.md` is the hot path (`SUMMARY.md` Key Rules point there) — relocating a still-live rule's full text entirely into a file literally named *archive* would bury it behind a lookup a reader has no reason to make. An `OBSOLETE`/`REMOVED` key has no such concern; nothing is still supposed to be finding it in the hot path.
   - `memory/episodic/archive/learnings-YYYY-Hn.md` (`Hn` = `H1` Jan–Jun / `H2` Jul–Dec of the current year) is **append-only** — previously written pointers elsewhere already carry `:line` numbers into this file (Step 5c criterion-b stubs, and any earlier archival's own header), so inserting anything above existing content silently shifts every earlier line number onto the wrong entry. Create the file if missing; otherwise always add new content at the **end** of the file, never at the top or in the middle.
   - At the end of the file, write a one-line header noting the archival date, reason, and the key's registry status at archival time — `obsolete-per-registry (MEM-NNN status OBSOLETE/REMOVED)` for criterion (a), `superseded-by-episodic-<file> (MEM-NNN status ACTIVE — live rule, relocated for LEARNINGS.md size; pointer left at LEARNINGS.md)` for criterion (b). Carrying the status means anyone reading the archive file in isolation can tell a live rule from a dead lesson without cross-referencing the registry.
   - Immediately below that header, append the entry **verbatim** — preserve the `[MEM-NNN]` key and any inline links. This bucket keeps archived lessons grep-searchable but out of hot-path memory.
   - **If the key is `OBSOLETE`/`REMOVED` (criterion a):** remove the entry from `memory/core/LEARNINGS.md` entirely — nothing else needs to keep citing a dead key.
   - **If the key is still `ACTIVE` (criterion b only):** do NOT delete the entry outright. Replace it in `memory/core/LEARNINGS.md` with a pointer stub, same convention as Step 5d/9e (path relative to `memory/`, plus the line where the copied entry now starts in the archive file): `- [MEM-NNN] → see episodic/archive/learnings-YYYY-Hn.md:<line> — <one-line hook>` (or a heading pointer at the entry’s original `##`–`######` level: `<original heading marker> [MEM-NNN] → see ... — <hook>`). The key stays `ACTIVE` in the registry untouched, and it stays cited in `LEARNINGS.md` itself (via the stub) — only the full narrative relocates, the same way Step 5d shrinks a duplicated entry to a pointer.

3. **Log it** in the markdown report under `## LEARNINGS.md Reduction`:
   - Which entry was moved (MEM key + first 60 chars), archival reason, size delta (bytes before → after)
   - Registry status (`OBSOLETE`/`REMOVED`) or link to the superseding episodic file
   - Which archival mode fired: **full removal** (criterion a) or **pointer stub** (criterion b, key stays `ACTIVE`)

4. **Constraints:**
   - Move *at most 1 archival per cycle* — gradual reduction, not a big-bang refactor
   - *Never fully remove* (criterion a) an entry currently referenced by `memory/SUMMARY.md` "Key Rules" section — that's a signal it's still load-bearing, and full removal is the one mode with no trail left behind; downgrade the SUMMARY reference first in a future cycle. This does **not** gate criterion (b)'s pointer-stub mode — a `SUMMARY.md` reference still resolves through the stub (`LEARNINGS.md` → archive file), so the load-bearing concern this constraint exists for doesn't apply there.
   - If no safe candidate exists (no `OBSOLETE`/`REMOVED` keys and no resolved-episodic-follow-up entries, or all remaining entries are keyless or younger than 30 days), skip this step and note `no safe candidate found — LEARNINGS.md at N bytes, no archival-eligible entries` in the report. Do NOT force an archival to hit the threshold.

Add `memory/core/LEARNINGS.md` and the archive file to `filesChanged` when archival fires.

Prepare both files without changing live memory, then submit their complete desired contents together through `consolidation-apply.sh` with `step 5c`. Require its checkpoint success before Step 5d.

This ensures steady progress toward the threshold while requiring lifecycle-provenance (MEM_REGISTRY or episodic) rather than unstructured age-based deletion.

### 5d. LEARNINGS.md Promoted-Entry Trim

`teamvibeai/poller-brain#300`: Step 5c above only fires when an entry's `[MEM-NNN]` key is `OBSOLETE`/`REMOVED`, or when a resolved episodic follow-up exists. On a mature brain, load-bearing lessons stay `ACTIVE` forever; before `teamvibeai/poller-brain#335`'s pointer-stub fix, that made the resolved-episodic-follow-up criterion unreachable too, so Step 5c's gate could go many consecutive cycles with "no safe candidate" while `LEARNINGS.md` kept growing regardless (measured: a brain with 9 consecutive no-candidate Step 5c cycles at 8.6x the byte cap). This step targets a case Step 5c still cannot reach even after #335: an entry with no resolved-incident narrative at all, that started as a short lesson but later got a full writeup in `semantic/`, `episodic/`, or `procedural/` for some other reason — the short and full versions now say the same thing twice, and the short one can shrink to a pointer without losing anything.

Different brains write `LEARNINGS.md` as top-level `- ` bullets or `##`–`######` heading blocks; each heading owns all nested headings and bullets until the next same-or-higher-level heading or EOF (inner bullets are never candidates), ambiguous/unsupported spans are reported as skipped, and apply re-parses the result to verify untouched entries byte-for-byte before writing; heading pointers retain the entry’s original `##`–`######` level, and proposal and apply preserve any `(Source: ...)` provenance.

> **Scope — single-key entries only, and never touches Step 5c's job.** Detection is content-based (same heuristic as Step 9e, `lib/citation-detect.ts`): an entry is a candidate only if it cites EXACTLY ONE `MEM-NNN` key ACROSS ITS WHOLE SPAN AND some `semantic/`/`episodic/`/`procedural/` file has a genuine single-key citation of that key (index/lookup-table destination lines are excluded from evidence and reported separately, never silently dropped). Most `LEARNINGS.md` entries already bundle multiple keys from manual consolidation (`(konsoliduje [MEM-1][MEM-4]...)`) — those are permanently out of scope for this step, since a multi-key entry's prose isn't attributable to any single key. This step never deletes a whole entry — full removal stays Step 5c's job for `OBSOLETE`/`REMOVED` keys (criterion a). Since `teamvibeai/poller-brain#335`, Step 5c's criterion (b) *also* shrinks a still-`ACTIVE` entry to a pointer, so "shrinks an ACTIVE entry to a pointer" alone no longer distinguishes this step from 5c(b) — the two are told apart by what they're evidence of, not by the mechanics: **5c(b)** fires on a closed *incident* (human judgment: a resolved/shipped follow-up exists in `episodic/`), **5d** fires on *duplicated content* one tier down (machine evidence: a genuine single-key citation elsewhere), regardless of whether any incident involved is resolved.

**Destination ownership (#447):** A citation is eligible only when its nearest real destination heading identifies exactly the same complete MEM key. Foreign-key, multi-key, obsolete, missing and generic unkeyed headings are rejected; an unkeyed nested heading does not inherit a keyed ancestor's ownership. Headings can themselves be citation lines. Fenced code and HTML comments supply neither headings nor evidence. The scanner reports `ownershipRejections` (key, file/line, heading, owners and reason) and keeps scanning for a later correctly owned section. This deliberately reduces proposals from generic headings. For a genuine promotion, add the key to the real destination heading (for example, `### Complete lesson [MEM-53]`), then rerun and review the proposal; never add a tag to unrelated content merely to qualify for trimming. Ownership remains a necessary check, not proof that the content restates the source.

> **Expected yield on a mature brain: likely zero.** Live-verified on the one brain where this was measurable (`teamvibeai/poller-brain#300` review, 2026-08-12): a real citing line very often mentions a key only as an incidental comparison ("...same bar as tag-author/MEM-2; single-source caveat") rather than condensing its lesson — content-based detection can surface the citation but cannot distinguish that shape (#244's shape #4) from a genuine restatement by regex. On that brain the step found exactly 1 candidate, and review rejected it as this false-positive shape — 0 valid trims. Treat "the reduction path exists and ran" as a different claim from "the reduction path found something usable": on a mature, well-cited brain, the reviewer's job in step 2 below is expected to be rejecting every candidate, not applying most of them.

> **False-positive shape #5 — a key can have MORE THAN ONE candidate (`teamvibeai/poller-brain#334`).** A cross-reference bullet inside a DIFFERENT key's entry (e.g. "...same fix as `[MEM-25]`") can itself parse as its own single-key "entry", alongside `MEM-25`'s own real entry — two candidates sharing one key, only one of them genuine. The propose output's headline copy-paste command deliberately omits any key with 2+ candidates; disambiguate with a span selector, `MEM-N@<entryStartLine>` (the line number printed next to each candidate) — see step 3.

If the Memory Metrics table (Step 9b) shows `LEARNINGS.md` over its (scaled) threshold, run the deterministic trim script:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-learnings-trim.ts" --completed-at "$START_HEAD"
```

**Rejected-review ledger (#530, slice 1):** Both trim scripts share `memory/.trim-review-state.json`, versioned per brain. Discovery, parse/coverage checks, and size/integrity validation still run every time. For each uncached proposal the script prints `review-ref MEM-…@<current-source-line>: <fingerprint>`. After explicitly rejecting that exact proposal, record it with the **same script**:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-learnings-trim.ts" --completed-at "$START_HEAD" --reject <printed-fingerprint> --reason "Incidental citation; does not preserve the lesson"
```

Use the invocation's recorded pre-Step-0/session-start HEAD as `START_HEAD` for both normal proposals and rejection recording. Never substitute a checkpoint or an older convenient final. Without this flag the script checks current HEAD; an unfinished checkpoint fails open to review. A changed/stale fingerprint refuses recording; rerun and review the current proposal. Record explicit semantic rejections only, never approvals, unreviewed proposals or inferred #505 guard failures. Each invocation records one rejection; repeat for other rejected proposals with their own fingerprints and reasons. Rejection recording atomically writes only the ledger, leaving source memory untouched. The normal memory checkpoint and final commit include it; require the completed final and matching markdown/JSON report pair before any record can suppress review in a later cycle. A working draft/checkpoint alone grants no suppression. Keep each rejection's reason in this cycle's markdown report and include the ledger in `filesChanged` when recording changes it. Do not put review bookkeeping into narrative destination files; the JSON ledger and generated `episodic/consolidation-progress-YYYY-MM-DD.md` files are excluded from this helper's evidence inventory.

A valid hit prints `previously rejected, unchanged: N` plus current source locations, original reasons/review times and references to the ledger record and completed report/commit; it omits those candidates from the review request. Report that count and reason references compactly, without re-reviewing or repeating the full proposal narrative. Identity includes source file, full legacy or dated MEM ID, exact entry-span digest, selected destination path, citing text/location, full destination context (including governing heading), ordered destination inventory and detector/review-policy fingerprints (installed scripts/skills plus base and per-brain CLAUDE/MAINTENANCE policy). Harmless source line shifts keep an unambiguous span's verdict; source/state history must prove continuous ownership, so removing a previously observed duplicate does not resurrect an older verdict; identical duplicate spans never reuse a verdict, and different same-key spans have independent records. Source/context edits, changed/new/missing destinations, policy/evidence-selection changes, missing/corrupt/incompatible state or interrupted writes restore normal review. Add `--reconsider` to a proposal invocation when an explicit reconsideration request is pending. A leftover `.trim-review-state.json.lock` requires inspecting the interrupted write before recording again; reads fail open and never steal it. The cache never authorizes apply or stores/reuses approvals; the existing explicit `--apply --only` path and its ambiguity, #505 and size checks remain required. Review-state flags are rejected in apply mode.

1. **Run it** and read the always-printed parse summary (`entries=N, multi-key=M, pointers=P, candidates=C`) plus the ownership- and index-rejection lists, then the candidate list itself (key, `LEARNINGS.md` entry span, destination `file:line`, full citing line, proposed pointer). If the parse summary shows 0 entries on an over-cap file that contains `MEM-` keys, the script warns and skips instead of silently reporting "no-op" — treat that as an entry-format mismatch to investigate, not a clean result.
2. **Review each candidate** — does the citing line actually restate/condense this entry's lesson, or does it just mention the key in passing? Reject anything that isn't clearly the former (same judgment call as Step 9e).

   > **Hooks are a navigation aid.** Even a correctly keyed heading does not establish semantic equivalence. Judge the destination section's content, not hook-string equality.
3. **Prepare the approved subset in a scratch copy:** copy `memory/` and `CLAUDE.md` into a temporary brain directory, capture the live baseline HEAD and original LEARNINGS.md SHA-256, then run `BRAIN_ROOT="$CONSOLIDATION_SCRATCH" npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-learnings-trim.ts" --apply --only MEM-1,MEM-5,...`. Never run `--apply` against the live brain during this step. A key with only one candidate takes a bare key; a key with 2+ candidates (false-positive shape #5 above) is rejected as ambiguous unless you disambiguate with `MEM-N@<entryStartLine>`, e.g. `--only MEM-25@67,MEM-5`. The script count-verifies before writing — it aborts (exit 1) without writing if `LEARNINGS.md` would grow or if the set of distinct `MEM-N` keys cited in the file would change. Require those checks to pass, then submit the scratch LEARNINGS.md as the desired `content` through `consolidation-apply.sh` with `step 5d`. Require its checkpoint success before Step 6; a successful scratch trim alone does not finish this step.
4. **Log it** in the markdown report under `## LEARNINGS.md Promoted-Entry Trim`: proposed count, approved/applied keys, newly rejected candidates (record each fingerprint/reason in the ledger as above), cached `previously rejected, unchanged` count with reason references, size delta, and the verify checks.
5. **Report tracking:** add `memory/core/LEARNINGS.md` to `filesChanged` when anything was applied (skip when nothing was proposed, or nothing was approved).
6. If `LEARNINGS.md` is under its (scaled) threshold, skip this step. If nothing needs fresh review, retain the compact cached-hit output when present; skip logging only when there are no candidates, cached hits or warnings.

An entry the script cannot find cited anywhere (or only ever cited ambiguously, or bundles multiple keys) is left with its full narrative — that's expected, not a failure.

### 6. Regenerate SUMMARY.md and append consolidation history

**Required history append (including zero promotions):** After regenerating SUMMARY.md below and before Step 6a, read the durable marker with `consolidation-marker.sh inspect .` and use its original UTC cycle date and full starting HEAD. Derive `YYYY` and `Hn` from that date: January–June is H1, July–December is H2. Append to `memory/episodic/archive/consolidation-history-YYYY-Hn.md`, even across midnight, June/July or December/January. Create the archive if absent; preserve every existing byte. Append exactly this bounded record, substituting the marker identity and a factual, substantive single-line description of work already performed:

```markdown
## Consolidation YYYY-MM-DD / START_HEAD
Status: in progress
Work performed: Reviewed memory tiers; zero promotions; regenerated SUMMARY.md with current pointers.
<!-- /consolidation-history -->
```

Separate it from prior content with a newline. `Work performed` must describe actual work (at least 20 characters and three words); replace the example with this cycle's results, including promotion counts or zero promotions. The key is **cycle date plus starting HEAD**, not date alone. Add this exact archive path to cumulative `filesChanged`. A retry reuses this cycle's verified append, including one protected by Step 6a; never append a duplicate or rewrite existing archive bytes. A previous same-day cycle cannot satisfy this requirement. Missing or conflicting evidence blocks the boundary; do not auto-backfill or repair it.

Keep `Status: in progress` through final verification. Follow **No forward completion citations**: cite only existing checkpoints and describe only completed work; never predict a final SHA, completion or completed-report link. Any later completion annotation follows the existing separate-commit procedure after verified final/report evidence.

**Always regenerate `memory/SUMMARY.md` on every consolidation run — this step is non-negotiable, even if no facts were promoted in steps 2–4.** A lightweight consolidation with zero promotions must still regenerate SUMMARY.md to ensure it reflects the current state of all memory tiers.

**Mandatory timestamp:** The first line of SUMMARY.md (before all sections) MUST be updated to `**Last consolidated:** YYYY-MM-DD HH:MM UTC` with the current date and time. This timestamp guarantees the file always differs from its previous version — eliminating the silent-skip risk when memory content is unchanged. Even on a zero-promotion run, the timestamp must be freshened. A SUMMARY.md with a stale "Last consolidated" line from a prior run means Step 6 did not execute.

**Regeneration inputs (read before replacing SUMMARY.md):** Read the previous `memory/SUMMARY.md` and record its UTF-8 byte size (previous final size; use `not present` on first creation). Inventory its relocation pointers, actionable rule/preference hooks, and any unique/load-bearing text. Read all `memory/core/*.md`, scan `memory/semantic/`, `memory/episodic/`, `memory/procedural/` for file listing, and read the sources of existing relocation pointers and relevant new material. Compile these inputs into the SUMMARY.md format defined in the memory skill. Target ~100-150 lines.

- Carry forward valid relocation pointers **and their actionable hooks** as authoritative short representations; do not re-expand already-relocated narrative from source files. Incorporate new MEM-derived material as concise actionable hooks/pointers without reintroducing that narrative. Preserve unique/load-bearing rules from the previous SUMMARY even if absent from other tiers.
- Resolve each carried pointer to its intended detail. If a source disappeared, moved, or changed materially, explicitly reconcile the pointer and hook against current evidence before replacing SUMMARY: update to a verified source, or preserve/recover the detail until it can be safely relocated. Never silently keep a broken pointer or discard its rule. Report the reconciliation; unresolved integrity alarms block Step 6a under Checkpoint Rules.
- After an interrupted relocation, inspect both SUMMARY and the destination before regenerating: reuse an already-written verbatim copy rather than appending it again, and never emit a pointer to detail that has not been written and verified. A later invocation must still follow the Pre-Step-0 audit/repair procedure.

Key sections:
- **How this memory works** — static block explaining what's in context vs. what requires lookup (copy verbatim from the template in the memory skill)
- **Identity** — who you are (from channel brain CLAUDE.md)
- **Key Rules** — actionable rules from LEARNINGS.md, each with a pointer to the source file for detail (e.g., "Always verify live data before trade proposals (detail: core/LEARNINGS.md)")
- **Preferences** — actionable preferences from PREFERENCES.md with pointer to source file
- **Active Projects** — from recent episodic/ entries
- **Deep Memory Index** — pointers to all memory tiers with topic summaries
- **Memory Catalog** — exact per-file links, or declared links to full catalog pages, following the memory skill's per-file catalog contract. Preserve existing declarations during regeneration; a directory/topic summary alone does not establish file coverage. Review catalog repairs through the existing scoped write/checkpoint workflow and track every changed page in `filesChanged`.

The "How this memory works" block MUST be the first section in SUMMARY.md. It is static content — do not rephrase or compress it, copy it from the template.

**Key Rules and Preferences must be actionable, not just labels.** Bad: "stale prices". Good: "Always verify live data before trade proposals (detail: core/LEARNINGS.md)". The pointer tells the agent where to find the full context if needed.

This replaces the old "Update MEMORY.md" step. SUMMARY.md is the new authoritative index.

**Report tracking (required):** Add `memory/SUMMARY.md` to the JSON report's `filesChanged` array immediately after completing this step — do not defer to Step 12. Also set `selfAssessment["summary-md-regenerated"]` to `true` in the JSON report at this point. Evaluators check both `filesChanged` and `selfAssessment["summary-md-regenerated"]` to verify this step ran. Omitting `memory/SUMMARY.md` from `filesChanged` fails the `summary-md-regenerated` criterion even when the file was correctly regenerated.

**Bounded size-cap reduction (mandatory when search is due — do not defer to reflection):** After regeneration, measure `S` with `wc -c memory/SUMMARY.md` (UTF-8 bytes, not characters or lines). Fix the successful-relocation budget once from this post-regeneration size: **0 if S <= 9000; otherwise min(3, ceil(S / 9000))**. Thus 15040 bytes permits two successful section relocations; sizes above 18000 permit at most three. Do not recompute or increase the budget during this run.

If over **9000 bytes**, apply the per-file retry contract after regeneration and pointer reconciliation. On `deferred`, skip only the loop below and report `deferred: structural stall` with budget **0 used / the fixed allowed budget**. Otherwise repeat the following until a stop condition fires:

1. **Select the largest eligible remaining section by property, not by section name.** SUMMARY structure varies across the fleet; never hardcode a brain's titles. A section is eligible only when its content is *regenerable from a lower memory tier* (`memory/semantic/`, `memory/episodic/`, `memory/daily/`) — e.g. a running-projects list or chronological history ledger. Already pointer-only sections are not candidates. Never trim static/load-bearing material: identity, the verbatim "How this memory works" block, repo tables, or Key Rules whose full text lives only here. If a section contains unique rules or information that exists nowhere else, protect it. Never mark ACTIVE memories obsolete to meet the cap.
2. **Prepare and verify a safe replacement before changing SUMMARY.** Preserve the overflow detail *verbatim*, including MEM identifiers and links, in the source-tier file it derives from (`semantic/` or `episodic/`). Preserve existing destination content; reuse a verified existing copy instead of duplicating it. Prepare a short pointer relative to `memory/` (e.g. `→ semantic/<file>.md`), retaining actionable rule/preference hooks where required by the template. Write the destination first, then read it back to verify the complete relocated text and verify that the proposed pointer resolves to that text before replacing the section. If either check is unavailable or fails, retain the original section; never drop unique/load-bearing rules or other content to save bytes.
3. **Require measured progress on every iteration.** Compare the current SUMMARY byte count with the proposed complete SUMMARY. Accept the replacement only if all preservation/pointer checks pass and the result is **strictly smaller**. Re-read and remeasure the accepted SUMMARY, record its before/after UTF-8 bytes, count one successful relocation, and add its destination to `filesChanged` immediately, even when reusing a verified existing copy. Also track any destination created/modified before a rejected replacement or interruption. Keep valid pointers and hooks from all previous iterations. If a result is invalid or non-shrinking, retain the last valid SUMMARY and stop with `no progress`; report the attempted section, proposed byte count, and failed check. Never retry an unchanged candidate in this run.
4. **Stop in this order:** at/below 9000 bytes (`under cap`, including an initially small SUMMARY with no relocations); otherwise when the successful-relocation budget is used (`budget exhausted`); otherwise if no eligible section remains (`no safe candidate`; distinguish a proven protected/pointer-only remainder from uncertainty under the retry contract); otherwise on the first invalid/non-shrinking result (`no progress`). Do not force a relocation when only protected or pointer-only content remains. Remaining overage is allowed and must be reported honestly. An unresolved integrity alarm still blocks the checkpoint; a stop reason does not clear it.

**Reduction report (required on every run):** Under `## SUMMARY.md Reduction`, record the previous final size (or `not present`), post-regeneration size `S`, each accepted section and destination with whole-SUMMARY bytes before → after, final size and remaining overage (`max(0, final - 9000)`), successful-relocation budget used/allowed, and the stop reason (`under cap`, `budget exhausted`, `no safe candidate`, `no progress`, or `deferred: structural stall`). For a conclusive zero-progress protected/pointer-only search also record `structurally stalled, needs human review` and establish retry evidence; ambiguous candidates and failed checks do not qualify. A deferred run still records every size/overage, the fixed budget, pointer reconciliation, prior attempt and unchanged next-eligible time. Include any rejected attempt and pointer/source reconciliation. This separates regeneration growth from relocation savings, even when no relocation succeeds. Keep `memory/SUMMARY.md` in `filesChanged` and `selfAssessment["summary-md-regenerated"] = true` as required above, alongside all relocation destinations tracked above.

Prepare and verify Step 6 edits directly and protect them with the existing Step 6a checkpoint below; **do not use `consolidation-apply.sh` for Step 6** (its transaction allowlist excludes this step).

**Mechanical tier-inventory refresh (mandatory, #482):** After the Step 6 tier mutations (including promotions, moves, deletions and reduction destinations), regenerate the inventory from the current brain tree, even on a zero-promotion run. From the brain root, save the helper's complete output outside `memory/` and `reports/`, then verify it against a fresh scan:

```bash
TIER_INVENTORY_DRAFT=$(git rev-parse --git-path consolidation-tier-inventory-YYYY-MM-DD.md)
node "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-tier-inventory.mjs" . > "$TIER_INVENTORY_DRAFT"
node "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-tier-inventory.mjs" . --check "$TIER_INVENTORY_DRAFT"
```

Require exit 0 from **both commands** before continuing. Read the generated `## Tier Inventory` block: verify promoted/moved destinations appear, retired paths are absent, and per-tier file counts/UTF-8 byte totals reflect the current `core/`, `semantic/`, `episodic/`, and `procedural/` tree. Paths are relative to `memory/`, recursively sorted; timestamps and non-tier files are excluded. Missing and empty tiers are explicitly distinguished. An unavailable brain/memory root, unreadable scan/file, symlink, unsupported entry or invalid UTF-8 is an error, never a successful empty inventory. On helper/check failure, stop consolidation, report the error and affected path through the existing failure-reporting flow, and investigate; do not silently skip, reuse stale output, or publish completed reports.

Refresh and verify again after any later tier mutation, including Step 5b's deferred retirement, trims, or progress-ledger creation/removal. Step 12 requires a final scan **after the last tier mutation** and embeds the unchanged generated block in the completed markdown report; Step 12a must commit that artifact in the report checkpoint. Keep it separate from `## Tier Coverage` and do not create a generated tier file or count this bookkeeping as a promotion. The draft outside memory is temporary evidence, not the committed artifact.

The 9000 B cap is a soft bound that keeps the always-in-context SUMMARY.md from crowding the working context. Encoding the trigger here removes the prior reliance on reflection-cycle recommendation chaining, where the same trim was re-proposed across cycles without ever landing (`teamvibeai/poller-brain#186`).

### 6a. Checkpoint Commit (crash-safety)

Before Step 6a, require exit 0 from the shared read-only history validator:

```bash
node "$CLAUDE_CONFIG_DIR/scripts/consolidation-history.mjs" . YYYY-MM-DD
```

It compares the append against the starting-HEAD archive, preserving prior bytes and checking the exact marker identity. A failure blocks this checkpoint; report the expected path, cycle identity and missing evidence, keeping the marker in place. The commit helper repeats this gate before staging.

**Commit now, before Step 7.** Protect SUMMARY.md regeneration and Steps 5–6 lifecycle work. Intermediate checkpoints bound a crash to work since the last checkpoint (#436). Apply **Checkpoint Rules** first: stop on any unresolved integrity alarm; reconcile unexpected changes; skip silently only if the allowed consolidation paths have no changes.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD "steps 5-6"
```

If Step 5b retained an unchanged split source for SUMMARY cutover, now perform its deferred retirement through the runbook's fresh `step 5b` manifest and require checkpoint success before Step 7. Keep the same one-source budget; this finishes that migration, not a second split.

### 7. Archive Old Daily Logs

This 30-day figure is also restated in base-brain `CLAUDE.md`'s memory-persistence rules (always in context, unlike this skill, which only loads during consolidation) — if this threshold ever changes, update that mention too so the two don't drift apart the way `MAINTENANCE.md` and this file did (`teamvibeai/poller-brain#318`).

For daily log files (format: `YYYY-MM-DD.md`) in `memory/daily/` that are older than 30 days:
- **Submit deletions through `consolidation-apply.sh` with `step 7`.** Their content has already been promoted to long-term memory in steps 2–4. Never delete live daily files directly; require the helper's committed success before continuing.
- Do NOT create weekly summary files (`weekly-*.md`) — they accumulate in `memory/daily/` and eventually become stale files themselves, causing this step to fail in future runs.
- If any weekly summary files from a previous approach still exist in `memory/daily/` and are older than 30 days, delete those too.
- After deletion, verify no files dated more than 30 days ago remain in `memory/daily/`.

**Recent-log retention (non-negotiable):** NEVER delete `memory/daily/<today>.md` or `memory/daily/<yesterday>.md`, regardless of whether their contents have been promoted. Same-day and next-day sessions rely on these files to recover context. Promotion is not a reason to delete; deletion is only for files dated 30+ days ago.

### 7a. Checkpoint Commit (crash-safety)

**Before Step 8 or any Step 9 work (#472)**, require successful `consolidation-apply.sh` submission for every Step 7 deletion. Each deletion batch is already committed before that helper returns. Stop on any unsubmitted deletion or unresolved alarm. Keep 9g for the later sweep/audit/trim work; the scoped helper below checkpoints any remaining report changes under **Checkpoint Rules**.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD "step 7"
```

### 8. Heartbeat Sweep & Self-Report

Heartbeat is being deprecated (`teamvibeai/teamvibe.ai#102`). Channel brain repos are private and live in customer GH orgs — the platform cannot inspect them. Each brain MUST self-report `HEARTBEAT.md` state so the eval pipeline can track migration progress.

**All scheduled times below are UTC.** `runAt` is ISO-8601 UTC, `cron` follows standard 5-field syntax in UTC. Do NOT use local time — agents run across timezones and the platform interprets schedules as UTC.

1. **Sweep** — if `HEARTBEAT.md` exists in the brain root:
   - For every unchecked `- [ ]` task:
     - Read the task text. If older than 30 days (per the `(added YYYY-MM-DD)` annotation or git blame on that line) and no longer relevant, mention it in `decisions` and delete it without scheduling — don't blindly schedule stale work.
     - Otherwise, write a clear `promptTemplate` for `create_scheduled_message` that restates the task in imperative form ("Check if PR #123 is merged. If not, ping the assignee."). Include any context the agent will need (links, deadlines).
     - Call `create_scheduled_message`. **If the call fails, leave the line in place and continue with the next item** — do NOT delete the source line until you have confirmation that the schedule was created. Record the failure in `decisions`.
     - Once the call succeeds, delete the migrated line.
   - Remove all completed `- [x]` lines.
   - If the file then has no real content (only blank lines, headings, or HTML comments), delete it.
   - Add `HEARTBEAT.md` to the JSON report's `filesChanged` if it was modified or deleted.
   - Include in `decisions`: how many items were migrated, how many deferred (failures or stale), file kept or deleted.

2. **Self-report** — populate `heartbeatStatus` in the JSON report (always, even when `HEARTBEAT.md` does not exist):

   ```json
   "heartbeatStatus": {
     "present": <bool: file exists at brain root after sweep>,
     "nonEmpty": <bool: file has any non-task content line — see definition below>,
     "itemCount": <int: number of unchecked '- [ ]' lines>
   }
   ```

   **`nonEmpty` definition:** true if the file contains at least one line that is NOT one of: blank, a heading (`#`), an HTML comment, or a completed `- [x]` task line. This means a file with only completed tasks counts as empty (the next sweep will remove them anyway).

   Goal state: `present: false`. The eval pipeline aggregates this across all reports to know when platform-side heartbeat code can be removed (`teamvibe.ai#101`).

### 9. MEM Audit, Memory Catalog Audit & Memory Metrics

Run integrity checks on the MEM registry, independently audit file discoverability, and collect memory size metrics.

#### 9a. MEM Integrity Check

If `memory/MEM_REGISTRY.md` exists:

1. **Count ACTIVE keys** — grep the registry for ACTIVE entries
2. **Verify presence** — for each ACTIVE key, grep across `memory/` (excluding `MEM_REGISTRY.md`, `daily/`, `.trim-review-state.json` and generated consolidation-progress bookkeeping) to confirm the key exists in at least one content file. A missing ACTIVE key = integrity violation. Step 5c's pointer-stub mode leaves the key in `LEARNINGS.md` (via the stub), so this check is unaffected by it either way — an ACTIVE key whose *only* home is `episodic/archive/` (e.g. because a later edit dropped the stub) is a Step 5c discoverability violation even though this grep would still find it there.
3. **Check sequence (legacy IDs only)** — extract numbers only from complete `MEM-<n>` IDs (never a dated ID prefix), verify gaps match REMOVED/OBSOLETE entries in the registry. An unexplained gap = potential data loss.
4. **Compare with previous run** — if the previous consolidation report exists, compare ACTIVE counts. A decrease without corresponding OBSOLETE/REMOVED entries = alarm.

Record results in the markdown report under `## MEM Audit`:
```markdown
## MEM Audit
- Total keys: 12
- ACTIVE: 10, OBSOLETE: 1, REMOVED: 1
- New this cycle: 2 (MEM-011, MEM-012)
- Obsoleted this cycle: 0
- Integrity: ✅ all ACTIVE keys found in content files
- Sequence (legacy IDs only): ✅ no unexplained gaps
```

Populate JSON report `selfAssessment`:
- `mem-integrity-check` — `true` if all ACTIVE keys in either format are present and the legacy-only sequence is clean, `false` otherwise

If `memory/MEM_REGISTRY.md` doesn't exist (pre-migration brains), skip and set `mem-integrity-check` to `true` (no keys to check).

#### 9a-catalog. Memory Catalog Audit

**Run on every authorized consolidation after Step 6**, outside Step 9a's registry-exists conditional: zero promotions, no tier writes, a missing MEM registry, reduction-search deferral, or a previous zero never skip this audit. The existing whole-run scheduling and interrupted-cycle guards still apply.

From the brain root, run the deterministic read-only helper:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-catalog-audit.ts"
# If the brain explicitly uses memory/index.md (or another local catalog):
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-catalog-audit.ts" --catalog index.md
```

SUMMARY is always the entry point. `--catalog` asserts that the given memory-relative path is declared reachable from SUMMARY; it cannot bypass linkage. The memory skill's **Per-file catalog contract** defines the supported section/link syntax, recursive tier inventory, exact normalized path matching and exclusions. Follow only declared catalog pages with cycle detection, never arbitrary content links.

Copy the helper's freshly measured `## Memory Catalog Audit` block into the markdown report: attempted index path(s), UTC measurement time, total, catalogued, uncatalogued count (`0/N` included), and sorted missing paths. A confirmed empty inventory may report `0/0`. Missing/unreadable pages, unsupported syntax or scan failures yield `incomplete`, error details and an unknown uncatalogued count (exit 1), never a green zero. Preserve those errors; do not substitute a previous report's count. Exit 0 can still contain a discoverability warning for omissions.

For missing paths or an incomplete audit, record a visible discoverability warning in existing `observations` and a concrete repair recommendation in `processImprovements` (e.g. add exact links to the declared catalog, link the intended catalog from SUMMARY, or resolve the reported read/format/scan error). These findings alone do not assert data loss, change `mem-integrity-check`, or create an integrity alarm blocking checkpoints. Actual preservation failures still follow existing stop rules. Keep this block **separate from `## Tier Coverage`**, whose path parser treats Markdown paths as promotion evidence; do not count catalog omissions or audit output as tier promotions. Add no report-schema or fleet fields.

The helper never repairs files. If consolidation reviews and repairs catalog entries, preserve unrelated content, use its existing scoped write/checkpoint workflow and record changed paths in `filesChanged`. Keep the initial measured result and rerun for a separately labelled final measurement. Recheck after **any subsequent change to a scoped tier file or catalog page**, including Step 9 trims and Step 10 backfills, before Step 12 reports the final state. Prior reports are comparison history only.

#### 9b. Memory File Size Metrics

Measure sizes of key memory files and include a `## Memory Metrics` section in the markdown report.

**How to measure:** Run `wc -c` on each file (skip files that don't exist):
- `CLAUDE.md`, `memory/SUMMARY.md`, `memory/TODAY.md`, `memory/MEM_REGISTRY.md`
- `memory/core/LEARNINGS.md`, `memory/core/PREFERENCES.md`, `memory/core/MISTAKES.md`

For `LEARNINGS.md` and `MEM_REGISTRY.md`, don't compare the size against a flat number — run the scaled-threshold script instead (see **Scaled thresholds** below) and use its printed `threshold` value in the table.

**Include this table in the markdown report:**
```markdown
## Memory Metrics
| File | Size (bytes) | Threshold | Status |
|------|-------------|-----------|--------|
| CLAUDE.md | 2800 | 10000 | :white_check_mark: |
| SUMMARY.md | 4200 | 9000 | :white_check_mark: |
| LEARNINGS.md | 3100 | 5000 (scaled, 7 entries) | :white_check_mark: |
| MEM_REGISTRY.md | 800 | 5000 (scaled, 3 rows) | :white_check_mark: |
| PREFERENCES.md | 2100 | 5000 | :white_check_mark: |
| MISTAKES.md | 3400 | 5000 | :white_check_mark: |
| TODAY.md | 1100 | — | — |
```

**Thresholds** (flag as :warning: if exceeded):
- `CLAUDE.md` > 10000 — risk: instruction overload
- `SUMMARY.md` > 9000 — risk: context bloat
- `LEARNINGS.md` — risk: too many rules to follow (reduction paths: Step 5c archival, Step 5d promoted-bullet trim)
- `MEM_REGISTRY.md` — risk: registry too large (archive REMOVED entries, trim promoted ACTIVE rows)
- `PREFERENCES.md` > 5000 — risk: preference set too large to track reliably. Same 5000B convention originally shared with LEARNINGS.md/MEM_REGISTRY.md, added `teamvibeai/poller-brain#300` — previously untracked, meaning a brain could accumulate an unbounded PREFERENCES.md with no signal in this report. **Tracking only for now**: flag :warning: when exceeded, but there is no dedicated preferences reduction step yet (Step 9f handles MISTAKES.md). Measure the overage and flag this base-brain capability gap in `processImprovements` (Step 11) for review; preserve live preferences when no safe action exists. A preferences reducer remains a separate follow-up. **Deliberately stays on the flat 5000B cap** (not scaled like its two siblings below) — PREFERENCES.md has no enforced entry format and no existing parser, so there's nothing reliable to scale against yet; revisit once a reduction mechanism exists.
- `MISTAKES.md` > 5000 — risk: staging area grows unbounded and stops being a scannable to-do list. Added `teamvibeai/poller-brain#328` — the existing consolidate Step 5 ("Promote Mistakes") was meant to cover this via a `status:` lifecycle but never fires on any brain, so this file had no reduction path at all before now (Step 5's dead trigger is tracked separately, not fixed here). Reduction path: Step 9f, but 9f only reaches entries that demonstrably cite a promotion elsewhere — a brain over cap with no such citations stays over cap with no further action available; flag it in `processImprovements` (Step 11) rather than treat the :warning: as self-resolving. **Stays on the flat 5000B cap** (not scaled like LEARNINGS.md/MEM_REGISTRY.md below) — Step 9f actively archives/points resolved entries out rather than only ever growing, so the lifecycle-append-only argument for scaling doesn't apply here.

**Scaled thresholds for `LEARNINGS.md` / `MEM_REGISTRY.md`** (`teamvibeai/poller-brain#324`, `teamvibeai/poller-brain#300`): both files are lifecycle-append-only in practice — a mature, `ACTIVE`-heavy brain's row/entry count only grows, since the reduction gates (Step 5c/5d/9d/9e) only ever touch `OBSOLETE`/`REMOVED`-keyed or demonstrably-duplicated content, never live `ACTIVE` narrative. A flat 5000B cap on such a file isn't a "trim harder" signal, it's mathematically unreachable past a certain row/entry count — verified on `teamvibeai/poller-brain#324`: 58 registry rows × 85B (shortest real row) + 231B overhead = 5161B, already over cap with every row at its practical minimum. Run:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-scaled-threshold.ts" --mode registry
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-scaled-threshold.ts" --mode learnings
```

Each prints UTF-8 size, row/entry count, threshold and a final JSON result. A file warns only when `sizeBytes > threshold`; equality is OK. The 5000B floor keeps small/young brains from receiving an artificially tight cap.

- **LEARNINGS.md:** `threshold = max(5000, 300 + entries × 150)` (unchanged).
- **MEM_REGISTRY.md** (`teamvibeai/poller-brain#536`): `threshold = max(5000, 300 + Σ rowBudget)`. Each row gets `max(150, pointerRowBytes)` for a recognized trim pointer, otherwise 150B. Pointer bytes include the complete ID (legacy `MEM-<n>` or dated `MEM-YYYY-MM-DD-HHMMSS-<uuid>`), preserved Status/Created cells, separators/newline, path, line digits where emitted, and hook label. Four-column rows have `see <file>.md — <hook>` in Description; five-column rows also have the **same** `<file>.md:<line>` in Obsoleted, so both path occurrences count. Parsing shares the trim writer's escaped-pipe handling; Unicode paths/labels are measured in UTF-8 bytes. Legacy ` - ` pointers are also recognized. The CLI reports `pointerRows`, `nonPointerRows`, `rowBudgetBytes`, `structuralExtraBytes` above 150B/row, and line-numbered `diagnostics` for malformed rows/pointers that receive only 150B.

The registry budget covers the current trim writer's full pointer output, including long paths and heading hooks. **Hooks currently have no length limit**, so a fixed healthy-hook allowance cannot guarantee that valid trim output fits. Consequently pointer-label verbosity is not a warning signal under this policy; non-pointer narrative rows still get only 150B, and non-row prose gets only the fixed 300B overhead allowance. Large policy sections or a verbose untrimmed remainder can therefore still warn even after a successful trim. A fixed hook allowance would need a separate bounded-hook policy in the writer; no hook condensation or registry migration is required here.

Use this CLI's printed `threshold` and `overCap` everywhere this skill compares LEARNINGS.md/MEM_REGISTRY.md against "the cap" (this table, Step 5c preflight, Step 5d/9d/9e triggers). Do not reconstruct the old `300 + rows × 150` registry cap. Rerun after Step 9d/9e and record pre/post size and threshold: removing rows can lower the threshold faster than file size. See `lib/mem-scaled-threshold-core.ts` for the shared evaluator and constants. PREFERENCES.md and MISTAKES.md retain their flat 5000B policies.

Step 9b measurements and warnings remain required even when Step 6 or 9c candidate discovery is deferred. Keep the measured overage and human-review flag visible; deferral is not a healthy size result.

#### 9c. CLAUDE.md Gradual Reduction

If the Memory Metrics table (Step 9b) shows `CLAUDE.md` exceeding 10000 bytes, apply the per-file retry contract immediately before searching. On `deferred`, report current size/overage, the last actual search, unchanged deadline and human-review flag, then continue to Step 9d. When search is due, attempt **one** small extraction per consolidation cycle:

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
   - If unsure whether a block is safe to move, retain it and report `no safe candidate found — ambiguous`; this does **not** establish structural backoff. Only a full search proving all remaining content protected/already pointer-only, with no extraction, may record `structurally stalled, needs human review` and retry metadata. Failed verification/interruption is not a stall.
   - If `CLAUDE.md` is at/below 10000 bytes, skip candidate search and clear its stale backoff (`under-cap`). Successful extraction also clears backoff, even if still over cap

This ensures steady progress toward the threshold while allowing time to detect regressions between cycles.

#### 9d. MEM_REGISTRY.md REMOVED-Row Archival

`MEM_REGISTRY.md` is append-only for audit reasons — REMOVED rows are never deleted (Step 1c), so the registry grows unbounded. This step relocates **dead REMOVED audit rows** to `memory/MEM_REGISTRY_ARCHIVE.md`, leaving a single navigable pointer stub in the live registry. ACTIVE / OBSOLETE rows and all prose stay untouched.

> **Scope — mechanical only.** This automates relocation of *dead* data (rows already marked REMOVED via the MEM lifecycle). It does **not** touch ACTIVE/OBSOLETE rows or inline policy prose (e.g. HOLD-rule sections) — relocating live content is a semantic judgment that stays with reflection, not this automated step. On registries whose bulk is live prose, the byte target may need a complementary manual prose move; that is out of scope here.

If the Memory Metrics table (Step 9b) shows `MEM_REGISTRY.md` over its (scaled) threshold, run the deterministic archival script:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-registry-archive.ts"
```

The script accepts both ID formats without renumbering. It is **idempotent** (a second consecutive run is a byte-identical no-op) and performs its own **count-verify** before writing — it aborts (exit 1) without writing if any relocated REMOVED row would be dropped (round-trip identity). A same-ID row whose content differs from the archived row stays untouched in the live registry, with a `duplicate MEM id <id>: live row differs from archived row (not archived)` diagnostic for explicit repair; only these conflicting rows may remain REMOVED. Do not hand-edit `MEM_REGISTRY.md` to remove REMOVED rows; always use the script.

1. **Run it** and read the printed summary (relocated keys, `removedFromLive`, `newlyArchived`, `alreadyInArchive`, `liveRemovedAfter`, size delta, verify checks).
2. **On non-zero exit**, treat it as an integrity alarm: do NOT commit a partial state, and record the failure in the report. Investigate before retrying.
3. **Log it** in the markdown report under `## MEM_REGISTRY Archival`: relocated keys, size delta, and the three verify checks (`round-trip`, `count`, `live REMOVED == retained conflicting rows`); report any duplicate diagnostic for explicit repair.
4. **Report tracking:** add `memory/MEM_REGISTRY.md` and `memory/MEM_REGISTRY_ARCHIVE.md` to `filesChanged` when the script relocated any rows (skip both when it was a no-op).
5. If `MEM_REGISTRY.md` is under its (scaled) threshold, or the script reports a no-op, skip logging this step.

The stub the script leaves is a pointer — `> 📦 N REMOVED audit entries archived to [MEM_REGISTRY_ARCHIVE.md](...) — Keys: ...` — so the audit trail stays navigable from the live registry. The key list keeps archived legacy IDs navigable; new IDs are dated and `mem-write.ts` allocates no counter.

#### 9e. MEM_REGISTRY.md Promoted-Row Trim

`MEM_REGISTRY.md` keeps the full-length narrative for every row forever, even after that same content has been condensed into prose and merged into `memory/core/LEARNINGS.md` (or a semantic/episodic/procedural file) — the same fact then lives twice, once in each file, in full length. This is the actual current growth driver for registries whose bulk is live (non-REMOVED) rows. This step accepts both ID formats, including full dated IDs in `--only`, and rewrites a row to a short pointer once its content has demonstrably been promoted, leaving Key/Status/Created untouched; existing IDs are never renumbered.

> **Detection is content-based, not status-based, and it only PROPOSES — it never auto-writes from a blind scan.** A row is a trim candidate only if some destination file literally cites its `MEM-N` key as the sole key on that line (works regardless of a brain's own lifecycle-status convention for "promoted" — never reads Status). Three adversarial review rounds with DevGuru (poller-brain#244) each surfaced a *new* false-positive shape for "a file cites this key, therefore it's safe to trim" — bookkeeping mentions in `episodic/`, "sibling family" listings in `core/`/`semantic/`, and citations that are a single key but an incidental "per this rule" justification inside an unrelated sentence. Citing a key is not proof of being that key's condensed content, and getting it wrong means irreversibly overwriting real narrative with an unrelated pointer — so this script never trusts a blind scan enough to write on its own. It has two modes:
>
> - **Propose (default, for the existing backlog):** lists candidates needing review with their full citing lines (not just extracted hooks), plus a compact count/reason reference for unchanged completed rejections. Writes nothing unless explicitly recording a rejection as described below.
> - **Apply (explicit, for either a reviewed backlog subset or a fresh same-day promotion):** `--apply --only <comma-separated keys>` rewrites exactly those keys. There is no "apply everything found" mode — you always name the keys.

**Destination ownership (#447):** A citation is eligible only when its nearest real destination heading identifies exactly the same complete MEM key. Foreign-key, multi-key, obsolete, missing and generic unkeyed headings are rejected; an unkeyed nested heading does not inherit a keyed ancestor's ownership. Headings can themselves be citation lines. Fenced code and HTML comments supply neither headings nor evidence. The scanner reports `ownershipRejections` (key, file/line, heading, owners and reason) and keeps scanning for a later correctly owned section. This deliberately reduces proposals from generic headings. For a genuine promotion, add the key to the real destination heading (for example, `### Complete lesson [MEM-53]`), then rerun and review the proposal; never add a tag to unrelated content merely to qualify for trimming. Ownership remains a necessary check, not proof that the content restates the source.

**Content-coverage guard (#505):** Before proposing a row, the script requires its complete normalized Description to equal a complete normalized line in the accepted heading section (ending at the next real heading of any level), optionally after removing one leading `[MEM-…]` or `MEM-…:` prefix for that same key. Normalization applies Unicode NFC, folds whitespace (including NBSP, narrow NBSP and thin space) to one ASCII space, trims, and removes one leading list marker (`- `, `* `, `+ `, `1. `). Destination lines are checked separately, never joined. Nothing else is removed or folded: trailing periods, case, digits, signs (including `−`), currencies, punctuation, URLs and Markdown remain literal. Substrings, paraphrases, reordered details, case changes and partial matches are rejected.

Both modes add a machine-readable `contentCoverage: <JSON array>` line. Each entry retains `key`, `file`, `line`, `status`, `tokens`, and `missingTokens`. The script emits only `covered` or `rejected`; `tokens` is always empty, and `missingTokens` is empty when covered or `["no-literal-match"]` when rejected. **A rejected row is not proposed and cannot be applied with `--only`. Rejected means do not hand-trim it either. Preserve the complete entry text in the destination first, then rerun and review.** Empty descriptions also fail closed. Text elsewhere in the file, under a nested heading, or inside fenced code/comments cannot satisfy coverage for the accepted section.

**Backfill path (existing bloat, Step 9b over threshold):**

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-registry-trim.ts" --completed-at "$START_HEAD"
```

**Record explicit rejections using the shared Step 5d ledger contract:** run this registry script with `--completed-at "$START_HEAD" --reject <printed-fingerprint> --reason "<specific rejection reason>"`. Use its printed fingerprint, never a bare MEM ID. The same completed-cycle requirement, invalidation, duplicate isolation, bookkeeping exclusion and `--reconsider` option apply. Read `previously rejected, unchanged: N` and retain the reason references in the report; only the remaining proposals need review. Automatic `no-literal-match` rejections remain coverage output and are never cached as human verdicts.

1. **Run it** and read the ownership-rejection list and coverage report (including `no-literal-match` rejections), then the candidate list (key, `file:line`, full citing line, proposed pointer).
2. **Review each candidate** — does the citing line actually restate/condense this key's content, or does it just mention the key in passing (a bookkeeping tally, a "per this rule" justification for something else)? Reject anything that isn't clearly the former.
3. **Apply the approved subset:** `npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-registry-trim.ts" --apply --only MEM-1,MEM-5,...`. The script performs its own **count-verify** before writing — it aborts (exit 1) without writing if the registry would grow or if its row/citation counts don't add up.
4. **Log it** in the markdown report under `## MEM_REGISTRY Promoted-Row Trim`: proposed count, approved/applied keys, newly rejected candidates (record explicit review fingerprints/reasons in the ledger), ownership and coverage reasons, cached `previously rejected, unchanged` count with reason references, size delta, and the verify checks. Include the ledger in `filesChanged` when recording changes it.
5. **Report tracking:** add `memory/MEM_REGISTRY.md` to `filesChanged` when anything was applied (skip when nothing was proposed, or nothing was approved).
6. If `MEM_REGISTRY.md` is under its (scaled) threshold, skip this step. If nothing is proposed, skip logging only when there are no ownership or coverage rejections, cached hits or warnings to report.

**Incremental path (a promotion Step 1b/4 just wrote and grep-verified THIS run):** you already know the exact key, destination file, and line because you just wrote and verified it. Apply it immediately: `--apply --only <that key>`. The same content-coverage guard still runs: if rejected, preserve the complete entry text in the destination first and rerun; never bypass rejection with a hand edit.

A row the script cannot find cited anywhere (or only ever cited ambiguously) is left with its full narrative — that's expected, not a failure, whether that's because it's genuinely not yet promoted or because a candidate was reviewed and rejected.

#### 9f. MISTAKES.md Promoted-Entry Trim & Archival

`memory/core/MISTAKES.md` is meant to be an active staging to-do list, but it has no reduction path — the existing Step 5 ("Promote Mistakes") is supposed to retire an entry once its lesson is promoted, but nothing in the actual write path (`mem-write.ts`, Step 1b.4) ever emits the `status:` field Step 5's trigger depends on, so it cannot fire on any brain (`teamvibeai/poller-brain#328`). This step accepts both ID formats, including full dated IDs in `--only`, without renumbering existing IDs. It rewrites an entry to a short pointer once its lesson has demonstrably been promoted elsewhere, same content-based detection as Step 5d/9e — never keyed off `status:`.

> **Two things happen on a trim, not one.** `MISTAKES.md` entries often carry incident-specific detail (exact date, exact failure scenario) that a condensed `LEARNINGS.md`/`semantic/`/`procedural/` restatement drops, so pointer-shrinking in place (Step 5d's approach) would silently lose that detail forever:
> 1. The full original entry is archived **verbatim** to `memory/episodic/archive/mistakes-YYYY-Hn.md` (half-year bucket, same convention as Step 5c's learnings archive) — nothing is deleted, only relocated.
> 2. The entry in `MISTAKES.md` is replaced with a short pointer citing the destination that proves promotion. The archive location itself is surfaced once, in a single aggregate stub line at the end of the file (same amortized pattern Step 9d's registry archival uses for N archived rows) — not a per-entry annotation, since on a short entry that made the pointer longer than the entry it replaced. Every archived entry's own provenance header still embeds its `[MEM-N]` tag, so it stays directly `grep`-able.
>
> **Detection reuses `citation-detect.ts`** — same heuristic and adversarial hardening as Step 9e (`teamvibeai/poller-brain#244`/`#300`) against index-shaped lines, multi-key ambiguity, and unreliable hooks. Read candidates as evidence for human review, never as auto-write proof — same propose/apply split as Step 9e's script. `core/LEARNINGS.md` is itself a valid destination for this step (unlike Step 5d's LEARNINGS-trim, which excludes all of `core/`), since a mistake is commonly promoted straight into a LEARNINGS rule rather than a semantic/procedural writeup.

**Destination ownership (#447):** A citation is eligible only when its nearest real destination heading identifies exactly the same complete MEM key. Foreign-key, multi-key, obsolete, missing and generic unkeyed headings are rejected; an unkeyed nested heading does not inherit a keyed ancestor's ownership. Headings can themselves be citation lines. Fenced code and HTML comments supply neither headings nor evidence. The scanner reports `ownershipRejections` (key, file/line, heading, owners and reason) and keeps scanning for a later correctly owned section. This deliberately reduces proposals from generic headings. For a genuine promotion, add the key to the real destination heading (for example, `### Complete lesson [MEM-53]`), then rerun and review the proposal; never add a tag to unrelated content merely to qualify for trimming. Ownership remains a necessary check, not proof that the content restates the source.

If the Memory Metrics table (Step 9b) shows `MISTAKES.md` exceeding 5000 bytes, run the deterministic trim script:

```bash
npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-mistakes-trim.ts"
```

**Entry boundaries:** a `##`/`###` heading with a bracketed identity tag in its title or introductory prose owns its supporting bullets, including references to other keys. A keyless category heading with no introductory prose contains independent top-level `- ` entries when every bullet start carries a key. Continuation lines stay with their bullet. Category text and untouched siblings are preserved. Flat bullet entries remain supported; see the memory skill's **MISTAKES.md Entry Format** for examples. A bare key reference alone does not establish heading ownership.

1. **Run it** and read the printed parse summary (`entries=N, multi-key=M, pointers=P, candidates=C`) plus the ownership-rejection, index-rejection and unreliable-hook lists, then the candidate list itself (key, `MISTAKES.md` entry span, destination `file:line`, full citing line, proposed pointer). An over-cap file containing `MEM-` keys where recognized entries cover only a small fraction of the file's bytes is flagged as a likely entry-format mismatch, not treated as a clean result — this catches a misparse even when `entries > 0` (e.g. a stray sub-bullet misread as its own entry), not just a 0-entries result.
   Read structural warnings too: unresolved ownership is reported with the affected span and keyed bullet start line numbers even at high byte coverage or below cap. Investigate these spans; they produce no candidates and cannot be applied. Safe entries outside them may still be reviewed and approved when the byte-coverage guard passes. An investigation warning is never a clean `No-op.` result.
2. **Review each candidate** — does the citing line actually restate/condense this entry's lesson, or does it just mention the key in passing? Reject anything that isn't clearly the former (same judgment call as Step 9e).
3. **Apply the approved subset:** `npx tsx "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-mistakes-trim.ts" --apply --only MEM-1,MEM-5,...`. There is no "apply everything found" mode — you always name the keys. The script count-verifies before writing — it aborts (exit 1) without writing if the round-trip/archival counts don't add up.
4. **Log it** in the markdown report under `## MISTAKES.md Promoted-Entry Trim`: proposed count, approved/applied keys, rejected candidates (with a one-line reason), archive bucket, size delta, and the verify checks.
5. **Report tracking:** add `memory/core/MISTAKES.md` and the touched `memory/episodic/archive/mistakes-YYYY-Hn.md` to `filesChanged` when anything was applied (skip both when nothing was proposed, or nothing was approved).
6. If `MISTAKES.md` is under 5000 bytes, or nothing is proposed, skip logging this step unless a parse/structural warning was reported. Record warnings and the required investigation even when no entries can be trimmed.

An entry the script cannot find cited anywhere (or only ever cited ambiguously, or bundles multiple keys) is left with its full narrative — that's expected, not a failure.

### 9g. Checkpoint Commit (crash-safety)

**Commit again now, before continuing to Step 10 — unless an unresolved integrity alarm fired in Steps 7-9.** Apply **Checkpoint Rules**. This checkpoint protects the heartbeat sweep, MEM audit, and size-reduction work from Steps 8–9; Step 7a already protected retention deletions.

**Exception — do not run this checkpoint if Step 9d's integrity-alarm condition fired and is still unresolved.** Step 9d already instructs: "On non-zero exit, treat it as an integrity alarm: do NOT commit a partial state, and record the failure in the report. Investigate before retrying." That instruction takes precedence over this checkpoint — committing here would silently override it. If Step 9d (or any other Step 7-9 sub-step) raised an unresolved alarm, stop and investigate per that step's own guidance instead of running the commit below; do not proceed to Step 10 with an unresolved alarm either.

If no unresolved alarm is pending:

```
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD "steps 8-9"
```

Skip silently if the allowed consolidation paths have no changes since the Step 7a checkpoint.

### 10. Assess Daily Log Compliance

Before self-critique, run observable checks on the daily log scratchpad and record the outcome in both reports.

Checks (all over the last 7 days unless specified):

1. **Today's log exists.** First, determine if user sessions ran today *before* this consolidation by running `git log <session-start-HEAD> --oneline --since='midnight'`. Use the pre-Step-0 HEAD recorded at session start (or this cycle's original HEAD from its ledger) to exclude this run's checkpoint commits; they are maintenance work, not evidence of earlier user sessions.
   - **No pre-consolidation commits today:** write `Today's log: no user sessions before this consolidation — not applicable` in the compliance section; set `daily-log-exists-today` to `true` in selfAssessment (criterion is excluded from scoring for this report).
   - **Pre-consolidation commits exist today:** verify `memory/daily/YYYY-MM-DD.md` (the file that Step 0 archived from TODAY.md) exists and contains content from those sessions (more than just a consolidation stub line). If it does, write `Today's log: present, N entries ✅`; set `daily-log-exists-today` to `true`. If it is missing or contains only a consolidation stub, write `Today's log: missing or stub-only despite N commits today ❌`; set `daily-log-exists-today` to `false`.
   - **Important:** Do NOT use `memory/TODAY.md` for this check — Step 0 resets it to a bare consolidation stub regardless of whether sessions ran. Only `memory/daily/YYYY-MM-DD.md` contains actual pre-consolidation session content.
2. **Continuous appends.** Today's log (or the most recent day that had 2+ sessions) contains 2+ distinct timestamped or bulleted entries — not a single dump. A file with a lone session-end paragraph fails this check.
3. **Retention.** `memory/TODAY.md` exists with today's header, and `memory/daily/<yesterday>.md` is present after consolidation completes.
4. **No empty logs.** No `memory/daily/*.md` file is empty or contains only a header.
5. **Weekly coverage.** Before computing the ratio, **enumerate and backfill session days**:
   - Run `git log --format='%as' --since='7 days ago' -- . | sort -u` to list unique session days (dates with ≥1 commit, deduplicated across multi-commit days).
   - **Inactive brain shortcut.** If the enumeration returns zero session days (dormant brain, paused-channel agent, or fresh brain pre-first-commit), write `Coverage: 0/0 (n/a) — no sessions in the trailing 7 days` in the `## Daily Log Compliance` markdown section and set `selfAssessment.daily-log-weekly-coverage` to `true` (criterion is not applicable). Skip the backfill loop below and skip the **Weekly coverage special rule** self-critique below — neither applies when there were no sessions to log. Continue to the remaining checks.
   - For each session day that lacks a `memory/daily/YYYY-MM-DD.md` file, **create the stub file now** with a `# YYYY-MM-DD (DAY)` header (e.g., `# 2026-05-28 (Thu)`) for consistency with normal daily logs, followed by one entry per commit: `- (backfilled from git) — <commit subject>`. If a day has > 3 commits and most are trivial chore commits, you may collapse them into a single bullet: `- (backfilled from git) — N commits: <comma-joined subjects, truncated to ~120 chars>`. Do this proactively — chore commits ("remove processed maintenance reports", cleanup jobs) routinely skip log-write.ts and create gap days that lower coverage. Do not wait for a "check fails" signal; backfill first, then compute.

   Then compute `days_with_daily_log / days_with_any_session`. Target ≥ 0.8. "Days with sessions" = **any day with at least one commit to this brain repo** — this includes chore commits (e.g., "remove processed reports"), maintenance runs, and consolidation-only commits. Do NOT exclude a day just because it had no user interaction; if there was a commit, it counts in the denominator. Days with no commit at all (e.g., Slack-only response days where no file was modified) are NOT in the denominator and do not affect coverage. **The computed ratio MUST be written explicitly in the `## Daily Log Compliance` markdown section as a fraction and percentage — for example: `Coverage: 6/7 (86%) ✅` or `Coverage: 2/3 (67%) ⚠️`.** The scorer reads only the markdown report; a missing or implicit ratio fails the criterion even if `selfAssessment.daily-log-weekly-coverage` is `true`.
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

**Weekly coverage special rule:** if the enumeration step in bullet 5 found ≥1 session day requiring backfill (i.e., any session day lacked a `memory/daily/YYYY-MM-DD.md` file before backfill), you MUST add a `[self-critique]` entry to `processImprovements` — **unconditionally, regardless of post-backfill coverage ratio**. The self-critique fires on **gap existence**, not on the post-backfill ratio: backfill repairs the ratio; the self-critique documents the root cause so the gap doesn't recur. This entry MUST go in `processImprovements` — do NOT put it in `decisions` or `observations`. A valid self-critique entry MUST name (1) the root cause and (2) one concrete prevention — not just acknowledge the gap. Filler entries (e.g., "I forgot, will try harder") do not satisfy the requirement. Reporting weekly coverage without the required `processImprovements` [self-critique] when backfill was needed ALWAYS fails the criterion, with no exceptions.

Example low-coverage self-critique: `"[self-critique] Coverage 3/7 (43%): sessions on 2026-05-17, 2026-05-18, 2026-05-20 had no daily log — 2026-05-17 and 2026-05-18 were chore-commit-only days (no log-write.ts call), 2026-05-20 had no write because TODAY.md was archived into a single cross-day file. Will add log-write.ts call to chore commits going forward."`

Do not silently pass a failing check.

### 10a. Persist Compliance Ledger and Checkpoint

Before self-critique, write the Step 10 compliance results, cumulative `filesChanged`, completed-step boundary, session-start HEAD, and any prior-cycle recovery/occurrence counts to `memory/episodic/consolidation-progress-YYYY-MM-DD.md`. Include the working JSON fields (`filesChanged`, `selfAssessment`, `processImprovements`) in a fenced JSON block. Carry both targets' retry entries and actual attempt/deadline evidence in this in-progress ledger too; they become usable only in the completed, committed report. Mark this ledger explicitly as **in progress**, not completed evidence. Keep drafts outside `reports/` so the platform cannot ingest an unfinished report. This ledger preserves bookkeeping if the session dies before reporting (#462).

**Commit that ledger and daily-log backfills before Step 11.** Apply **Checkpoint Rules** first: stop on any unresolved integrity alarm; reconcile unexpected changes; skip silently only if the allowed consolidation paths have no changes.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD "step 10"
```

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

### 11a. Detect and Escalate Own Rescue Refs

Before generating reports, execute [MAINTENANCE.md — Rescue Branch Detection](../../../MAINTENANCE.md#rescue-branch-detection)
(`$CLAUDE_CONFIG_DIR/MAINTENANCE.md` at runtime): run push-health and the own-ref
query, evaluate each ref at seven elapsed days, and apply the durable per-ref
ledger's submission/reconciliation rules with checkpoints before submission and
after its result. Preserve `memory/rescue-ref-escalations.md` across trimming,
archival, and removal of Step 10a's temporary progress ledger; carry changed
ledger paths and detection/escalation outcomes into the reports. Follow the
section's uncertainty rules if the remote query, age, ledger, or submission
cannot be confirmed. Do not automatically resolve rescue refs.

### 12. Produce Report

**Versioned completion invariant:** Include top-level `"consolidationHistory": {"version": 1, "cycleDate": "YYYY-MM-DD", "startingHead": "START_HEAD"}` in the JSON report, using the durable marker's original UTC date and full starting HEAD. This metadata opts new reports into required committed-history verification; it is not proof by itself. Legacy committed reports without this field remain recognized without backfill. New report-checkpoint/final helper calls require v1 metadata and the valid append, even on zero-promotion runs.

**Required top-level field — `operationType` (set FIRST, verify before commit):** The JSON report MUST contain `"operationType": "consolidation"` as a top-level field (NOT inside `selfAssessment`). This is the *single hard-required* field: the poller **permanently deletes** any report missing it — no retry, and the run never reaches the eval pipeline. After writing the JSON, grep the file for `"operationType"` and confirm (a) the value is exactly `consolidation` and (b) the match is a *top-level* key — same indentation as `"filesChanged"`/`"selfAssessment"`, not nested inside `selfAssessment` (a nested match still gets the report deleted). If absent or nested, fix it before committing.

**Pre-report `filesChanged` verification:** Before writing the report, confirm these required entries are in `filesChanged`:
- `memory/SUMMARY.md` — mandatory every run (Step 6). If missing from `filesChanged`: do NOT just add the filename — go back and execute Step 6 now, regenerate `memory/SUMMARY.md` from current memory state, then add it to `filesChanged`. Skipping Step 6 silently is not allowed.
- `selfAssessment["summary-md-regenerated"]` — must be explicitly set to `true` every run. This is a separate requirement from `filesChanged`. If not yet set: set it to `true` now. Evaluators check this field independently — a missing or `false` value fails the criterion even when SUMMARY.md is in `filesChanged`.
- `memory/TODAY.md` — mandatory every run (Step 0). If missing from `filesChanged`: do NOT just add the filename — go back and execute Step 0 now (reset TODAY.md with today's header and a consolidation start entry if not already done, append any existing content to today's daily log), then add `memory/TODAY.md` to `filesChanged`. Skipping Step 0 silently is not allowed.
- `memory/daily/YYYY-MM-DD.md` — the archived daily log (Step 0); add it now if missing (omit only when TODAY.md did not exist prior to this run)
- `memory/MEM_REGISTRY.md` — if any `[MEM-NNN]` entries were processed or lifecycle changes made in steps 1b/1c; add it now if missing

Before reporting the final catalog result, rerun Step 9a-catalog if scoped tier files or catalog pages changed after its measurement, including any new tier archive files. Keep initial and final measurements distinct.

Prepare both report drafts outside `reports/`, carrying forward Step 10a's ledger fields without dropping compliance, recovery, or cumulative file tracking. Verify that the drafts preserve the ledger's content, then remove the in-progress ledger before the final tier-inventory scan (removing it changes `episodic/` counts and bytes). Regenerate and verify the inventory using Step 6's commands after this and all other tier mutations. Include the complete generated `## Tier Inventory` block unchanged in the markdown draft, under its own heading outside `## Tier Coverage`. Publish both verified reports:

- **Markdown:** `reports/YYYY-MM-DD-memory-consolidation.md` (must include the verified `## Tier Inventory` block, the per-file retry block and truthful reduction statuses from the retry contract, plus `## Daily Log Compliance` from Step 10, `## MEM Audit` from Step 9a, `## Memory Catalog Audit` from Step 9a-catalog, and `## Memory Metrics` from Step 9b)
- **JSON:** `reports/YYYY-MM-DD-memory-consolidation.json` (must include `daily-log-*` and `mem-integrity-check` keys in `selfAssessment`, and the `[self-critique]` entry from Step 11 in `processImprovements`)

Before the report checkpoint, mechanically verify the embedded artifact against the current tree:

```bash
node "$CLAUDE_CONFIG_DIR/skills/memory/scripts/mem-tier-inventory.mjs" . --check reports/YYYY-MM-DD-memory-consolidation.md
```

Require exit 0 and inspect counts/paths as in Step 6. A mismatch or scan failure blocks completion: report and resolve it, regenerate after any tier changes, and reverify before Step 12a. Do not mutate tier files between this final verification and the report checkpoint. The existing `## Tier Coverage` checklist and JSON schema remain unchanged; inventory paths alone are not promotion evidence.

**Post-write existence check (required, added per pb#257):** After writing the JSON report, run `ls reports/YYYY-MM-DD-memory-consolidation.json` and confirm it exists on disk. This step is easy to drop silently on unusually busy sessions (many interleaved threads) — and when it's dropped, the poller's guard-file hook (`teamvibe.ai#128`) has nothing to POST, so `.last_consolidation` never updates even though real consolidation content landed. The next `maintenance-guard.sh` run then reports a false-overdue signal despite consolidation having actually happened. Verify the pair before Step 12a commits it. After that checkpoint, the platform may consume/delete JSON; use its committed copy as evidence and never recreate an already consumed report. If no committed report evidence exists and the check fails, stop and finish the report before closing the session.

For `selfAssessment.reduce-log-count`: set to `true` if at least one daily log was actively processed this run — either (a) Step 7 deleted one or more log files, OR (b) Steps 2–4 extracted content from at least one log and produced at least one ADD or UPDATE action. Set to `false` if no logs were processed (e.g., no logs in range, all NOOP). **Always include daily log files whose content was extracted in `filesChanged`**, even if they were not deleted — listing source logs gives the evaluator the evidence of log file activity it needs to verify this criterion.

### 12a. Checkpoint Commit (crash-safety)

Before Step 12a, require exit 0 from:

```bash
node "$CLAUDE_CONFIG_DIR/scripts/consolidation-history.mjs" . YYYY-MM-DD --report
```

This rechecks the append and report cycle metadata. Failure blocks completion, not merely self-critique. The helper repeats validation for `steps 10-12` and `final` before staging, including empty final commits. It preserves HEAD, index and marker on validation failure. For final, it checks committed report metadata (including Step 12a's JSON when consumed); never recreate consumed JSON.

**Commit the completed markdown/JSON reports and all Steps 10–12 changes immediately after Step 12, before the user-facing final report (#462).** Verify both report files exist and the required fields/checks from Step 12 pass first, including the mechanical check of the report's final tier inventory. This complements 10a, which protects compliance/bookkeeping before report completion. Apply **Checkpoint Rules** first: stop on any unresolved integrity alarm; reconcile unexpected changes; skip silently only if the allowed consolidation paths have no changes.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD "steps 10-12"
```

Verify that `git show <checkpoint-SHA>:reports/YYYY-MM-DD-memory-consolidation.md` contains the exact verified `## Tier Inventory` block. The report is the durable inventory artifact; the temporary draft alone does not satisfy this checkpoint requirement.

## Scoring Guidance

When deciding what to promote, weigh:
- **Frequency** — mentioned multiple times = more important
- **Recency** — recent information is more likely still relevant
- **Explicit signals** — user corrections and stated preferences are always high priority
- **Impact** — does this affect how you should behave in future sessions?

## Commit

Before Step 12a, verify both reports on disk and commit them as instructed in Step 12. After Step 12a, verify the pair in that checkpoint with `git cat-file -e <checkpoint-SHA>:reports/YYYY-MM-DD-memory-consolidation.md` and the corresponding `.json` path. JSON need not still exist on disk; never recreate a consumed report.

After Step 12a, apply **Checkpoint Rules** again and create the final completion marker. Unlike an intermediate checkpoint, this final commit must exist even if 12a left a clean tree: the mechanical guard requires an exact final subject after the newest checkpoint. The committed pair in Step 12a remains evidence even if the platform consumes JSON before this final marker. The helper excludes that deletion and preserves unrelated staged files. The final subject after the checkpoint distinguishes a finished cycle from checkpointed reports alone.

```bash
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-commit.sh" . YYYY-MM-DD final
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-state.sh" .
bash "$CLAUDE_CONFIG_DIR/scripts/consolidation-marker.sh" clear .
```

Require `consolidation_state: complete` before running `clear`. The lifecycle helper clears only when the marker's cycle has an exact final commit after its starting HEAD/latest checkpoint and committed report-pair evidence (including Step 12a if JSON was consumed), with markdown still on disk and no unfinished report edits. For v1 reports, state also validates the exact cycle record in the final commit tree against the starting-HEAD archive; an uncommitted append or metadata alone cannot prove completion. The starting HEAD must be an ancestor of both checkpoint and final. It leaves the marker in place on failure. An unfinished or malformed marker requires the explicit audited `repair` procedure above; use that command instead of manual marker removal.

Confirm the guard reports `consolidation_state: complete` before claiming completion to the user or adding completion citations. If it reports unfinished/unknown, stop and report; inspect the missing evidence and use the audited `repair` procedure for an interrupted marker. The intermediate boundaries are Step 0a (archive), 4a (promotions), 6a (SUMMARY/lifecycle), 7a (retention), 9g (sweep/audit/trims), 10a (compliance ledger), and 12a (completed reports).
