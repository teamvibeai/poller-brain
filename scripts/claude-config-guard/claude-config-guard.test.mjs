// Tests for the pb#299 tamper-guard hook pair (sync-baseline.mjs / check-bash-diff.mjs).
// Same style as mcp/__tests__ and skills/background-task — plain node, hand-rolled
// counters, no framework. Each test runs in its own throwaway git repo under the OS temp
// dir so baseline state (keyed by project path) never collides between runs.
//
//   node scripts/claude-config-guard/claude-config-guard.test.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SYNC = join(HERE, 'sync-baseline.mjs')
const CHECK = join(HERE, 'check-bash-diff.mjs')

let pass = 0, fail = 0
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n) }
  else { fail++; console.log('  ✗ FAIL', n, extra !== undefined ? `— ${extra}` : '') }
}

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ccg-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  mkdirSync(join(dir, '.claude/hooks'), { recursive: true })
  mkdirSync(join(dir, '.claude/skills'), { recursive: true })
  writeFileSync(join(dir, '.claude/hooks/example.sh'), '#!/bin/bash\necho hi\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

// Both hooks read a JSON payload on stdin: { cwd, tool_name, tool_input }.
function runHook(script, payload, env = {}) {
  try {
    const out = execFileSync('node', [script], {
      input: JSON.stringify(payload),
      cwd: payload.cwd,
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout: out.toString(), stderr: '' }
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() }
  }
}

function cleanBaselineFor(dir) {
  // Clear any baseline left by a prior run keyed to this exact tmp path (fresh mkdtemp
  // path each call makes this a no-op in practice, but keeps runs order-independent).
  const key = execFileSync('node', ['-e', `
    const { createHash } = require('node:crypto')
    process.stdout.write(createHash('sha256').update(process.argv[1]).digest('hex'))
  `, dir]).toString()
  const p = join(tmpdir(), 'claude-tamper-guard', `${key}.json`)
  if (existsSync(p)) rmSync(p)
}

// 1) First Bash observation for a fresh project: no baseline yet → trust current state as
//    the new baseline, but ALERT (not silent) -- DevGuru 08-10: a silent trust-and-exit
//    here is a one-`rm` bypass (delete the baseline file, then tamper, and it looks exactly
//    like a fresh project). Noisy on every genuinely-first call, by design.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  const r = runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } })
  ok('first observation: exits 2 (alerts, does not silently trust)', r.code === 2)
  ok('first observation: stderr explains no-baseline case', r.stderr.includes('No baseline found'))
  rmSync(dir, { recursive: true, force: true })
}

// 2) Untracked Bash write (simulating `cp`) after baseline exists → flagged, alert-only by
//    default, file NOT reverted.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } }) // seeds baseline
  writeFileSync(join(dir, '.claude/hooks/example.sh'), '#!/bin/bash\necho PWNED\n') // simulates cp bypass
  const r = runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cp /tmp/x .claude/hooks/example.sh' } })
  ok('untracked write: exit 2 (alert)', r.code === 2)
  ok('untracked write: names the changed file', r.stderr.includes('example.sh'))
  ok('untracked write: alert mode does not revert', readFileSync(join(dir, '.claude/hooks/example.sh'), 'utf8').includes('PWNED'))
  rmSync(dir, { recursive: true, force: true })
}

// 3) Same as #2 but with CLAUDE_TAMPER_GUARD_MODE=revert → file restored from git.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } })
  writeFileSync(join(dir, '.claude/hooks/example.sh'), '#!/bin/bash\necho PWNED\n')
  const r = runHook(
    CHECK,
    { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cp /tmp/x .claude/hooks/example.sh' } },
    { CLAUDE_TAMPER_GUARD_MODE: 'revert' },
  )
  ok('revert mode: exit 2 (still reports)', r.code === 2)
  ok('revert mode: restores committed content', !readFileSync(join(dir, '.claude/hooks/example.sh'), 'utf8').includes('PWNED'))
  rmSync(dir, { recursive: true, force: true })
}

// 4) Legitimate change via Edit/Write (sync-baseline.mjs) → next Bash call does NOT flag it.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } }) // seed
  writeFileSync(join(dir, '.claude/hooks/example.sh'), '#!/bin/bash\necho legit-change\n')
  runHook(SYNC, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: '.claude/hooks/example.sh' } })
  const r = runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } })
  ok('Edit/Write-mediated change: not flagged on next Bash call', r.code === 0)
  rmSync(dir, { recursive: true, force: true })
}

// 5) Out-of-scope Edit (outside .claude/hooks or .claude/skills) → sync-baseline is a no-op.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  writeFileSync(join(dir, 'README.md'), 'hello')
  const r = runHook(SYNC, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: 'README.md' } })
  ok('out-of-scope Edit: exits 0, no crash', r.code === 0)
  rmSync(dir, { recursive: true, force: true })
}

// 6) New file added under .claude/skills via Bash (not just modified) → flagged as added.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } })
  writeFileSync(join(dir, '.claude/skills/new-script.mjs'), 'console.log(1)')
  const r = runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'touch .claude/skills/new-script.mjs' } })
  ok('new file under scope: flagged as added', r.code === 2 && r.stderr.includes('new-script.mjs') && r.stderr.includes('added'))
  rmSync(dir, { recursive: true, force: true })
}

// 7) Revert mode on a NEW (never-committed) file: `git checkout` has nothing in HEAD to
//    restore -- the report must say so (not claim success it didn't achieve). DevGuru
//    08-10: the v1 version unconditionally printed "Reverted to the last committed state"
//    even when the underlying git/rm call had failed.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } }) // seed
  writeFileSync(join(dir, '.claude/hooks/brand-new.sh'), '#!/bin/bash\necho PWNED\n')
  const r = runHook(
    CHECK,
    { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cp /tmp/x .claude/hooks/brand-new.sh' } },
    { CLAUDE_TAMPER_GUARD_MODE: 'revert' },
  )
  // 'added' kind -> code path is `rm -f`, which DOES succeed on a real file (unlike
  // `git checkout` on an untracked path) -- covers the other failure mode: rm succeeds, so
  // the file WAS actually removed, and the report must match that outcome, not fake success.
  ok('revert of new file: reports reverted (rm succeeds)', r.stderr.includes('[reverted]'))
  ok('revert of new file: file actually gone', !existsSync(join(dir, '.claude/hooks/brand-new.sh')))
  rmSync(dir, { recursive: true, force: true })
}

// 8) Revert mode on a MODIFIED but never-committed baseline entry (git checkout fails --
//    nothing in HEAD for this exact content/path combo simulated by removing the file from
//    git's index while keeping it in the baseline) reports revert-failed honestly.
{
  const dir = freshRepo()
  cleanBaselineFor(dir)
  runHook(CHECK, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } }) // seed baseline (has example.sh)
  execFileSync('git', ['rm', '-q', '--cached', '.claude/hooks/example.sh'], { cwd: dir }) // now untracked from git's POV, but still in our baseline
  writeFileSync(join(dir, '.claude/hooks/example.sh'), '#!/bin/bash\necho PWNED\n')
  const r = runHook(
    CHECK,
    { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cp /tmp/x .claude/hooks/example.sh' } },
    { CLAUDE_TAMPER_GUARD_MODE: 'revert' },
  )
  ok('revert of untracked-modified file: reports revert-failed', r.stderr.includes('revert-failed'))
  ok('revert of untracked-modified file: message says still tampered', r.stderr.includes('still tampered'))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
