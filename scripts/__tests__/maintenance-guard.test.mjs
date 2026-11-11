// Run: node --test scripts/__tests__/maintenance-guard.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const zeroPromotion = `## Tier Coverage
- core/ (corrections, preferences, lessons): No new content — confirmed ✅
- semantic/ (facts, knowledge): No new content — confirmed ✅
- episodic/ (significant events): No significant events — confirmed ✅
- procedural/ (workflows): No new workflows — confirmed ✅
`

function dateAgo(days) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function brain(t, { today, newestDaysAgo = 3, promoted = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'reports'))
  for (const days of [newestDaysAgo + 1, newestDaysAgo]) {
    const report = promoted && days === newestDaysAgo
      ? zeroPromotion.replace('No new content — confirmed ✅', 'Updated core/PREFERENCES.md with MEM-12 ✅')
      : zeroPromotion
    writeFileSync(join(dir, 'reports', `${dateAgo(days)}-memory-consolidation.md`), report)
  }
  if (today !== undefined) {
    mkdirSync(join(dir, 'memory'))
    writeFileSync(join(dir, 'memory', 'TODAY.md'), today)
  }
  return dir
}

function guard(dir, overrides = {}) {
  // Isolate all policy knobs from the caller; UTC avoids date-boundary drift.
  const result = spawnSync('bash', ['scripts/maintenance-guard.sh', dir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TZ: 'UTC',
      CONSOLIDATION_WINDOW_START: '0',
      CONSOLIDATION_WINDOW_END: '24',
      CONSOLIDATION_IDLE_STREAK_MIN: '2',
      CONSOLIDATION_IDLE_FALLBACK_HOURS: '168',
      CONSOLIDATION_ACTIVITY_MEM_MIN: '1',
      CONSOLIDATION_ACTIVITY_BYTES_MIN: '32768',
      ...overrides,
    },
  })
  assert.ifError(result.error)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim().split('\n').length, 1)
  return result
}

const singleDay = () => `# ${dateAgo(0)}\n`
const memLines = (count) => singleDay() + Array.from({ length: count }, (_, i) => `- [MEM-${i + 12}] preference: remember this\n`).join('')

test('T1: one promotable MEM line overrides the idle streak', (t) => {
  const result = guard(brain(t, { today: memLines(1) }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle streak ignored: 1 \[MEM\]\/\[REMEMBER\] lines in TODAY\.md/)
})

test('T2: routine single-day logs still idle-skip', (t) => {
  const result = guard(brain(t, { today: singleDay() + '- [10:00] log: routine\n'.repeat(3) }))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /idle-skip/)
})

for (const headingCount of [2, 5]) {
  test(`T3b: multi-day routine log after ≥24h still idle-skips (${headingCount} headings)`, (t) => {
    const headings = Array.from({ length: headingCount }, (_, i) => `# ${dateAgo(headingCount - i - 1)}\n`).join('')
    const today = headings + '- [10:00] log: routine\n'.repeat(headingCount === 2 ? 1 : 20)
    assert.ok(Buffer.byteLength(today) < 32768)
    const result = guard(brain(t, { today }))
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stdout, /idle-skip/)
  })
}

test('T4: 40 KB of routine logs override the idle streak', (t) => {
  const today = singleDay() + '- [10:00] log: routine\n'.repeat(2000)
  assert.ok(Buffer.byteLength(today) >= 40 * 1024)
  const result = guard(brain(t, { today }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle streak ignored: \d+ bytes in TODAY\.md/)
})

test('T5: missing TODAY.md still idle-skips', (t) => {
  const result = guard(brain(t))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /idle-skip/)
})

test('T6: activity never overrides the recent-run rule', (t) => {
  const result = guard(brain(t, { today: memLines(10), newestDaysAgo: 0 }))
  assert.equal(result.status, 1, result.stdout)
  // BSD date preserves the current hour (0h elapsed); GNU uses midnight.
  assert.match(result.stdout, /last ran (?:[0-9]|1[0-9]|2[0-3])h ago, threshold 24h/)
  if (process.platform === 'darwin') assert.match(result.stdout, /last ran 0h ago/)
  assert.doesNotMatch(result.stdout, /idle streak ignored|idle-skip/)
})

test('T7: a promoted tier still breaks the report-based idle streak', (t) => {
  const result = guard(brain(t, { promoted: true }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /overdue/)
  assert.doesNotMatch(result.stdout, /idle streak ignored/)
})

for (const count of [2, 3]) {
  test(`T8: MEM minimum of 3 with ${count} MEM lines`, (t) => {
    const result = guard(brain(t, { today: memLines(count) }), { CONSOLIDATION_ACTIVITY_MEM_MIN: '3' })
    assert.equal(result.status, count === 3 ? 0 : 1, result.stdout)
    assert.match(result.stdout, count === 3 ? /idle streak ignored: 3 \[MEM\]\/\[REMEMBER\] lines/ : /idle-skip/)
  })
}

for (const extraByte of [0, 1]) {
  test(`byte minimum at actual UTF-8 size + ${extraByte}`, (t) => {
    const today = singleDay() + '- [10:00] log: příliš žluťoučký\n'
    const size = Buffer.byteLength(today)
    const result = guard(brain(t, { today }), { CONSOLIDATION_ACTIVITY_BYTES_MIN: String(size + extraByte) })
    assert.equal(result.status, extraByte === 0 ? 0 : 1, result.stdout)
    assert.match(result.stdout, extraByte === 0 ? new RegExp(`${size} bytes in TODAY\\.md`) : /idle-skip/)
  })
}

for (const inside of [true, false]) {
  test(`24–48h activity follows the time window (${inside ? 'inside' : 'outside'})`, (t) => {
    const result = guard(brain(t, { today: memLines(1), newestDaysAgo: 1 }), {
      CONSOLIDATION_WINDOW_START: inside ? '0' : '24',
      CONSOLIDATION_WINDOW_END: inside ? '24' : '25',
    })
    assert.equal(result.status, inside ? 0 : 1, result.stdout)
    assert.match(result.stdout, inside ? /inside window/ : /outside window/)
    assert.match(result.stdout, /idle streak ignored: 1 \[MEM\]\/\[REMEMBER\] lines/)
  })
}

test('168h idle fallback still forces a check-in without activity', (t) => {
  const result = guard(brain(t, { newestDaysAgo: 8 }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle but overdue.*forcing check-in run/)
})

for (const line of [
  'prose [MEM-12] mid-line',
  '- [MEM-feedback] malformed',
  ' - [MEM-13] indented',
  '[REMEMBER] keep this',
]) {
  test(`mid-line and malformed MEM tags and [REMEMBER] count as promotable: ${line}`, (t) => {
    const result = guard(brain(t, { today: singleDay() + line + '\n' }))
    assert.equal(result.status, 0, result.stdout)
    assert.match(result.stdout, /idle streak ignored: 1 \[MEM\]\/\[REMEMBER\] lines in TODAY\.md/)
  })
}

test('unbracketed MEM-12 and [MEMO] still idle-skip', (t) => {
  const today = singleDay() + 'prose MEM-12 without brackets\n[MEMO] keep this\n'
  const result = guard(brain(t, { today }))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /idle-skip/)
})

for (const [knob, value, reason] of [
  ['CONSOLIDATION_ACTIVITY_MEM_MIN', '0', /idle streak ignored/],
  ['CONSOLIDATION_ACTIVITY_BYTES_MIN', 'abc', /idle streak ignored: cannot parse TODAY\.md activity threshold/],
]) {
  test(`knob 0 means always, non-numeric knob bypasses idle-skip (${knob}=${value})`, (t) => {
    const result = guard(brain(t, { today: singleDay() }), { [knob]: value })
    assert.equal(result.status, 0, result.stdout)
    assert.match(result.stdout, reason)
  })
}

test('activity detection failure falls through to the time policy', (t) => {
  const dir = brain(t, { today: memLines(1) })
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'awk'), '#!/bin/bash\nexit 2\n', { mode: 0o755 })
  const result = guard(dir, { PATH: `${bin}:${process.env.PATH}` })
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle streak ignored: cannot read TODAY\.md activity/)
})

// Real git history exercises both the read-side citation guard and scheduling.
function history(t, options) {
  const dir = brain(t, options)
  const git = (...args) => {
    const result = spawnSync('git', args, {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const commit = subject => git('commit', '-q', '--allow-empty', '-m', subject)
  const checkpoint = (date = dateAgo(0)) => commit(`chore: consolidate memory checkpoint (${date}) — step 7`)
  const pair = (date = dateAgo(0)) => {
    writeFileSync(join(dir, 'reports', `${date}-memory-consolidation.md`), zeroPromotion)
    writeFileSync(join(dir, 'reports', `${date}-memory-consolidation.json`), '{"operationType":"consolidation"}\n')
  }
  return { dir, git, commit, checkpoint, pair }
}

function state(dir) {
  const result = spawnSync('bash', ['scripts/consolidation-state.sh', dir], {
    cwd: repoRoot, encoding: 'utf8',
  })
  assert.ifError(result.error)
  assert.equal(result.stderr, '')
  return result
}

for (const daysAgo of [0, 1, 3]) {
  test(`checkpoint without report requires resume even ${daysAgo} days later and outside window`, t => {
    const { dir, checkpoint } = history(t)
    checkpoint(dateAgo(daysAgo))
    const result = guard(dir, { CONSOLIDATION_WINDOW_START: '24', CONSOLIDATION_WINDOW_END: '25' })
    assert.equal(result.status, 0, result.stdout)
    assert.match(result.stdout, /consolidation_resume: true/)
    assert.doesNotMatch(result.stdout, /consolidation_needed/)
    assert.equal(state(dir).status, 1)
  })
}

test('report files on disk, staged or checkpointed, do not prove final completion', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  for (const stage of ['unstaged', 'staged', 'checkpointed']) {
    if (stage === 'staged') git('add', '-A')
    if (stage === 'checkpointed') commit(`chore: consolidate memory checkpoint (${dateAgo(0)}) — steps 10-12`)
    const result = guard(dir)
    assert.equal(result.status, 0, result.stdout)
    assert.match(result.stdout, /consolidation_resume: true/)
  }
})

test('completed final pair permits recent-run skip, including consumed JSON', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  git('add', '-A')
  commit(`chore: consolidate memory checkpoint (${dateAgo(0)}) — steps 10-12`)
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  for (const phase of ['present', 'consumed', 'deletion committed']) {
    if (phase === 'consumed') rmSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.json`))
    if (phase === 'deletion committed') { git('add', '-A'); commit('remove processed reports') }
    assert.equal(state(dir).status, 0, state(dir).stdout)
    assert.match(state(dir).stdout, /consolidation_state: complete/)
    const result = guard(dir)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stdout, /consolidation_needed: false/)
  }
  // Ordinary post-completion session activity must not restart the old cycle.
  mkdirSync(join(dir, 'memory'))
  writeFileSync(join(dir, 'memory', 'TODAY.md'), memLines(1))
  assert.equal(guard(dir).status, 1)
})

for (const missing of ['md', 'json']) {
  test(`a final subject without committed ${missing} report still requires recovery`, t => {
    const { dir, git, checkpoint, pair, commit } = history(t)
    checkpoint()
    pair()
    rmSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.${missing}`))
    git('add', '-A')
    commit(`chore: consolidate memory (${dateAgo(0)})`)
    assert.equal(state(dir).status, 1)
    assert.match(guard(dir).stdout, /consolidation_resume: true/)
  })
}

test('a completed earlier attempt on the same date does not hide a new checkpoint', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  git('add', '-A')
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  assert.equal(state(dir).status, 0)
  checkpoint()
  assert.equal(state(dir).status, 1)
})

test('wrong-date and lookalike final subjects do not satisfy the citation guard', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  git('add', '-A')
  commit(`chore: consolidate memory (${dateAgo(1)})`)
  commit(`chore: consolidate memory (${dateAgo(0)}) extra`)
  assert.equal(state(dir).status, 1)
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  commit(`chore: consolidate memory (${dateAgo(0)}) extra`)
  assert.equal(state(dir).status, 0)
})

test('edited completed report requires inspection; missing history is explicitly unknown', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  git('add', '-A')
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  writeFileSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.md`), 'unfinished rewrite')
  assert.equal(state(dir).status, 1)
  rmSync(join(dir, '.git'), { recursive: true })
  assert.equal(state(dir).status, 2)
  assert.match(state(dir).stdout, /unknown/)
})

test('no checkpoints keeps cadence policy; shallow history cannot certify old citations', t => {
  const { dir, git } = history(t, { newestDaysAgo: 0 })
  assert.match(state(dir).stdout, /consolidation_state: none/)
  assert.equal(guard(dir).status, 1)
  writeFileSync(join(dir, '.git', 'shallow'), `${git('rev-parse', 'HEAD')}\n`)
  assert.equal(state(dir).status, 2)
  assert.match(state(dir).stdout, /shallow history/)
})

test('commit-body examples cannot impersonate checkpoint or final subjects', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  git('add', '-A')
  commit(`documentation\n\nchore: consolidate memory (${dateAgo(0)})`)
  assert.equal(state(dir).status, 1)
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  commit(`documentation\n\nchore: consolidate memory checkpoint (${dateAgo(0)}) — step 0`)
  assert.equal(state(dir).status, 0)
})

test('a final report removed from disk requires recovery even when committed', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  git('add', '-A')
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  rmSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.md`))
  assert.equal(state(dir).status, 1)
})
