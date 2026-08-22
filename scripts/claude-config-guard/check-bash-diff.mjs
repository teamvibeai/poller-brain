#!/usr/bin/env node
// PostToolUse hook (matcher: "Bash") -- other half of the pb#299 tamper-guard pair.
//
// After every Bash call, diff the in-scope .claude/hooks/** + .claude/skills/** file set
// against the last trusted baseline (refreshed by sync-baseline.mjs on Edit/Write calls).
// Any change not attributable to Edit/Write gets flagged -- regardless of which Bash
// mechanism made it (`cp`, `sed -i`, `python -c`, `dd`, ...). This checks the RESULT, not
// the method, so unlike a command-name blocklist it can't be bypassed by a new trick
// (pb#299, Marosh 2026-08-10: "kontroluje vysledek ne cestu k nemu -- nejde obejit novym
// trikem").
//
// Default: ALERT only (exit 2 + stderr, same convention as review-marker-reminder.sh in
// individual channel brains). Revert is opt-in via env var CLAUDE_TAMPER_GUARD_MODE=revert
// -- MEM-75 precedent (this brain's own memory): auto-remediation without an explicit human
// go is a risk of its own, so the fleet-wide default stays report-only.
//
// Known limitations (draft, pending Jakub's product decision on pb#299 before this is
// enabled anywhere):
// - Detection is always AFTER the write already landed, never before.
// - The guard's own definition lives in settings.json, which is OUT OF SCOPE in phase 1 --
//   a Bash write to settings.json (e.g. deleting the "hooks" key) disables this guard
//   entirely, silently. Phase 1 does not detect its own disablement.
// - Baseline state (see lib.mjs) lives in a deterministic path under the OS temp dir,
//   readable/writable by anything with the same filesystem access as the session --
//   including the Bash tool this hook watches. DevGuru review (2026-08-10): a Bash call
//   that deletes the baseline file immediately before writing tampered content lands in
//   the "no baseline" branch below, which used to trust-and-exit silently -- a one-`rm`
//   bypass of the exact scenario this guard exists to catch. Fixed by making that branch
//   alert too (see below); it still can't stop the tamper (baseline is outside the hook's
//   control), but it stops being invisible. Moving baseline state fully out of Bash's reach
//   is out of scope for this v1.
import { execFileSync } from 'node:child_process'
import { readBaseline, readHookPayload, snapshot, writeBaseline } from './lib.mjs'

const payload = readHookPayload()
if (!payload) process.exit(0)

const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()

let baseline
let current
try {
  baseline = readBaseline(projectDir)
  current = snapshot(projectDir)
} catch {
  process.exit(0)
}

if (!baseline) {
  // No baseline to compare against -- either this is genuinely the first Bash call this
  // project has ever seen, or an existing baseline was deleted/reset (accidentally by /tmp
  // cleanup, or deliberately as a bypass -- see the DevGuru note above). Can't tell those
  // apart from here, and can't retroactively detect tampering that predates this
  // observation either way -- but trusting-and-exiting SILENTLY (the v1 behavior DevGuru
  // flagged) makes the deliberate case a one-`rm` invisible bypass. Alerting on every
  // occurrence, including the benign first-call case, trades noise for visibility: a fresh
  // baseline is now always a logged event, not just an assumption.
  try {
    writeBaseline(projectDir, current)
  } catch {
    /* best-effort */
  }
  console.error(
    '[claude-config-guard] No baseline found for .claude/hooks/** / .claude/skills/** in ' +
      'this project -- trusting current state as the new baseline. If this is the first ' +
      'Bash call of a fresh session, this is expected. If a baseline should already have ' +
      'existed, the previous one may have been deleted (accidentally, or as a deliberate ' +
      'bypass) -- treat as a possible tamper event and check git history / recent Bash ' +
      'commands for this project\'s .claude/hooks and .claude/skills paths.',
  )
  process.exit(2)
}

const changed = []
for (const [path, hash] of Object.entries(current)) {
  if (!(path in baseline)) changed.push({ path, kind: 'added' })
  else if (baseline[path] !== hash) changed.push({ path, kind: 'modified' })
}
for (const path of Object.keys(baseline)) {
  if (!(path in current)) changed.push({ path, kind: 'deleted' })
}

if (changed.length === 0) process.exit(0)

const mode = process.env.CLAUDE_TAMPER_GUARD_MODE === 'revert' ? 'revert' : 'alert'

// Tracks the ACTUAL per-file outcome rather than assuming success -- DevGuru review
// (2026-08-10): the previous version swallowed git checkout/rm failures in the try/catch
// below and then unconditionally reported "Reverted to the last committed state" in the
// final message, regardless of whether anything was actually restored. A newly-added,
// not-yet-committed file is the concrete failure case: `git checkout -- path` has nothing
// in HEAD to restore from, so it errors and the file is left exactly as tampered.
const revertResults = new Map()

if (mode === 'revert') {
  for (const { path, kind } of changed) {
    try {
      if (kind === 'added') {
        execFileSync('rm', ['-f', '--', path], { cwd: projectDir })
      } else {
        // Covers both 'modified' and 'deleted' -- git checkout restores either from the
        // last committed state. Uncommitted-but-legitimate baseline entries (an Edit/Write
        // change not yet committed) are a known gap of this simple v1: reverted to the
        // committed version, not the pre-Bash-call baseline. Flagged for the PR review.
        execFileSync('git', ['checkout', '--', path], { cwd: projectDir })
      }
      revertResults.set(path, 'reverted')
    } catch {
      revertResults.set(path, 'revert-failed')
    }
  }
  try {
    writeBaseline(projectDir, snapshot(projectDir))
  } catch {
    /* best-effort */
  }
}

const lines = changed
  .map(({ path, kind }) => {
    const marker = kind === 'added' ? '+' : kind === 'deleted' ? '-' : '~'
    const outcome = revertResults.has(path) ? ` [${revertResults.get(path)}]` : ''
    return `  ${marker} ${path} (${kind})${outcome}`
  })
  .join('\n')

const anyRevertFailed = [...revertResults.values()].includes('revert-failed')

console.error(
  `[claude-config-guard] Unexpected change under .claude/hooks/** or .claude/skills/**, ` +
    `not made via the Edit/Write tool (mode: ${mode}):\n${lines}\n\n` +
    (mode === 'alert'
      ? 'NOT reverted (alert-only default). If this change was intentional, make it once ' +
        'more through the Edit/Write tool to clear this alert on the next Bash call. If it ' +
        'was not expected, treat it as a possible tamper / prompt-injection event.'
      : anyRevertFailed
        ? 'Revert attempted but did NOT fully succeed for all files (see [revert-failed] ' +
          'above -- typically a newly-added, not-yet-committed file with nothing in git ' +
          'HEAD to restore from). Treat as still tampered until manually checked.'
        : 'Reverted to the last committed state.'),
)
process.exit(2)
