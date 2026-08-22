// Shared helpers for the pb#299 tamper-guard hook pair (sync-baseline.mjs +
// check-bash-diff.mjs). Not a hook itself -- imported by both.
//
// Phase 1 scope is deliberately narrow: executable/re-run content only
// (.claude/hooks/**, .claude/skills/**). settings.json, commands/, agents/ are phase 2
// -- DevGuru 08-10 (pb#299 thread): the exposure window this hook leaves (change lands,
// then gets caught on the *next* Bash call) only matters for content that gets re-executed
// mid-session. settings.json and commands/agents markdown don't hot-reload, so a same-
// session change there has no live-exploit window even before detection catches up.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

export const SCOPE_DIRS = ['.claude/hooks', '.claude/skills']

function walk(dir, projectDir, out) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, projectDir, out)
    else if (entry.isFile()) out.push(relative(projectDir, full))
  }
}

export function listScopedFiles(projectDir) {
  const out = []
  for (const rel of SCOPE_DIRS) walk(join(projectDir, rel), projectDir, out)
  return out.sort()
}

export function isInScope(relPath) {
  return SCOPE_DIRS.some((d) => relPath === d || relPath.startsWith(`${d}/`))
}

export function hashFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}

export function snapshot(projectDir) {
  const map = {}
  for (const rel of listScopedFiles(projectDir)) {
    map[rel] = hashFile(join(projectDir, rel))
  }
  return map
}

// Baseline state lives in the OS temp dir, keyed by project path -- never inside the
// brain's own git tree. Keeps the guard's own state file out of `git status`/diffs and out
// of scope for the very scan it drives; resets safely (fail-open to "trust current state")
// if /tmp is cleared or a fresh checkout is used.
//
// KNOWN GAP verified against teamvibe.ai source (DevGuru review, 2026-08-10): cron/
// maintenance sessions run in an ephemeral git worktree at
// `<brain>/.worktrees/<thread_id>/` (claude-spawner.ts, teamvibeai/teamvibe.ai#120),
// removed after the session ends, with a fresh thread_id (and therefore a different
// `projectDir`) EVERY run (see scheduler.ts's `scheduled:<scheduleId>:${Date.now()}`).
// Since the baseline key here is derived from `projectDir`, this guarantees the "no
// baseline" branch in check-bash-diff.mjs fires on literally every cron/maintenance
// session's first Bash call, not just on genuine resets -- alert-fatigue risk that needs a
// real fix (stable key independent of the worktree path, e.g. derived from the brain's own
// origin URL) before this guard is turned on for autonomous sessions. Interactive Slack
// sessions are unaffected (`ISOLATED_SOURCES` excludes 'slack' -- they run in the stable
// main brain dir, per claude-spawner.ts:1044-1051).
function baselinePath(projectDir) {
  const key = createHash('sha256').update(projectDir).digest('hex')
  const dir = join(tmpdir(), 'claude-tamper-guard')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${key}.json`)
}

export function readBaseline(projectDir) {
  const p = baselinePath(projectDir)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function writeBaseline(projectDir, snap) {
  writeFileSync(baselinePath(projectDir), JSON.stringify(snap))
}

export function readHookPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}
