// Run: node --test scripts/__tests__/maintenance-guard.test.mjs
import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

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

function brain(t, { today, newestDaysAgo = 3, promoted = false, coverage = zeroPromotion } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'reports'))
  for (const days of [newestDaysAgo + 1, newestDaysAgo]) {
    const report = promoted && days === newestDaysAgo
      ? zeroPromotion.replace('No new content — confirmed ✅', 'Updated core/PREFERENCES.md with MEM-12 ✅')
      : coverage
    writeFileSync(join(dir, 'reports', `${dateAgo(days)}-memory-consolidation.md`), report)
  }
  if (today !== undefined) {
    mkdirSync(join(dir, 'memory'))
    writeFileSync(join(dir, 'memory', 'TODAY.md'), today)
  }
  // Cadence tests need definitive history, including legacy runs without checkpoints.
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    } })
    assert.equal(result.status, 0, result.stderr)
  }
  git('init', '-q')
  for (const days of [newestDaysAgo + 1, newestDaysAgo]) {
    writeFileSync(join(dir, 'reports', `${dateAgo(days)}-memory-consolidation.json`), '{"operationType":"consolidation"}\n')
    git('add', '--', 'reports')
    git('commit', '-qm', `chore: consolidate memory (${dateAgo(days)})`)
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

test('T5: missing TODAY.md and four English no-new-content lines still idle-skip', (t) => {
  const coverage = zeroPromotion.replace(/No (?:significant events|new workflows)/g, 'No new content')
  const result = guard(brain(t, { coverage }))
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

const czechPromotion = zeroPromotion.replace('No new content — confirmed ✅', 'Aktualizováno `core/x.md` (MEM-135) ✅')

for (const [name, coverage] of [
  ['Czech promotions in both reports', czechPromotion],
  ['a markdown file reference without an English update or MEM key', zeroPromotion.replace('No new content — confirmed ✅', 'Aktualizováno `core/x.md` ✅')],
  ['a MEM key without a markdown file reference', zeroPromotion.replace('No new content — confirmed ✅', 'Aktualizováno MEM-135 ✅')],
  ['a malformed block with only three tier lines', zeroPromotion.split('\n').filter(line => !line.startsWith('- procedural/')).join('\n')],
]) {
  test(`Tier Coverage: ${name} prevents maintenance idle-skip`, t => {
    // Both reports are 72h+ old, below the idle fallback, with no TODAY override.
    const result = guard(brain(t, { coverage }))
    assert.equal(result.status, 0, result.stdout)
    assert.match(result.stdout, /consolidation_needed: true \(overdue/)
    assert.doesNotMatch(result.stdout, /idle-skip|idle streak ignored/)
  })
}

test('Tier Coverage: Czech promotions prevent reflection idle-skip', t => {
  const dir = brain(t, { coverage: czechPromotion })
  mkdirSync(join(dir, 'memory', 'episodic'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'episodic', `reflection-${dateAgo(4)}.md`), '# Reflection\n')
  const result = spawnSync('bash', [join(repoRoot, 'scripts/reflection-guard.sh'), dir], {
    cwd: repoRoot, encoding: 'utf8',
    env: {
      ...process.env, TZ: 'UTC',
      REFLECTION_OVERDUE_THRESHOLD_DAYS: '3', REFLECTION_IDLE_FALLBACK_DAYS: '7',
      CONSOLIDATION_IDLE_FALLBACK_HOURS: '168',
    },
  })
  assert.ifError(result.error)
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /reflection_needed: true/)
  const status = JSON.parse(result.stdout.split('REFLECTION_STATUS_JSON: ')[1])
  assert.equal(status.isOverdue, true)
  assert.equal(status.idleSkipped, false)
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
  writeFileSync(join(dir, '.history-fixture'), 'history base\n')
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
  test(`checkpoint without report blocks maintenance even ${daysAgo} days later and outside window`, t => {
    const { dir, checkpoint } = history(t)
    checkpoint(dateAgo(daysAgo))
    const result = guard(dir, { CONSOLIDATION_WINDOW_START: '24', CONSOLIDATION_WINDOW_END: '25' })
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout, /unfinished consolidation cycle/)
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
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout, /unfinished consolidation cycle/)
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
    assert.match(guard(dir).stdout, /unfinished consolidation cycle/)
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

// PR #602 review1: consumption, unknown history, scoped commits and report drafts.
function scopedCommit(dir, date, boundary, extra = []) {
  const result = spawnSync('bash', [join(repoRoot, 'scripts/consolidation-commit.sh'), dir, date, boundary, ...extra], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result
}

test('JSON consumed before final is proved by the report checkpoint, even if deletion was committed', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint()
  pair()
  git('add', '--', 'reports')
  commit(`chore: consolidate memory checkpoint (${dateAgo(0)}) — steps 10-12`)
  rmSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.json`))
  git('add', '--', 'reports')
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  assert.equal(state(dir).status, 0, state(dir).stdout)
  assert.match(state(dir).stdout, /complete/)
  assert.equal(guard(dir).status, 1)
})

for (const failure of ['shallow', 'missing repository', 'git log error', 'shallow query error']) {
  test(`unknown ${failure} is inspect before recent-report cadence`, t => {
    const { dir, git } = history(t, { newestDaysAgo: 0 })
    const overrides = { CONSOLIDATION_WINDOW_START: '24', CONSOLIDATION_WINDOW_END: '25' }
    if (failure === 'shallow') writeFileSync(join(dir, '.git', 'shallow'), git('rev-parse', 'HEAD') + '\n')
    if (failure === 'missing repository') rmSync(join(dir, '.git'), { recursive: true })
    if (failure.endsWith('error')) {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
      const predicate = failure === 'git log error' ? '"$3" = log' : '"$4" = --is-shallow-repository'
      writeFileSync(join(bin, 'git'), `#!/bin/bash\nif [ ${predicate} ]; then exit 2; fi\nexec '${actualGit}' "$@"\n`, { mode: 0o755 })
      overrides.PATH = `${bin}:${process.env.PATH}`
    }
    const result = guard(dir, overrides)
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout, /consolidation_inspect: true.*unknown/)
    assert.doesNotMatch(result.stdout, /consolidation_needed: false/)
  })
}

for (const phase of ['untracked', 'staged', 'committed without final']) {
  test(`checkpoint-free report draft (${phase}) requires reconciliation`, t => {
    const { dir, git, pair, commit } = history(t)
    pair()
    if (phase !== 'untracked') git('add', '--', 'reports')
    if (phase === 'committed without final') commit('unfinished report draft')
    assert.equal(state(dir).status, 1, state(dir).stdout)
    assert.match(state(dir).stdout, /unfinished consolidation cycle.*report/)
    const result = guard(dir)
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout, /unfinished consolidation cycle/)
  })
}

for (const boundary of ['step 0', 'steps 1-4', 'steps 5-6', 'step 7', 'steps 8-9', 'step 10', 'steps 10-12', 'final']) {
  test(`scoped ${boundary} commit preserves unrelated staged, unstaged and untracked work`, t => {
    const { dir, git, commit } = history(t)
    writeFileSync(join(dir, 'user-notes.md'), 'original\n')
    writeFileSync(join(dir, 'user-staged.md'), 'original\n')
    mkdirSync(join(dir, 'memory', 'daily'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'daily', 'old.md'), 'old archive\n')
    git('add', '-A')
    commit('user base')
    writeFileSync(join(dir, 'user-notes.md'), 'unstaged user draft\n')
    writeFileSync(join(dir, 'user-staged.md'), 'staged user draft\n')
    git('add', '--', 'user-staged.md')
    writeFileSync(join(dir, 'user-staged.md'), 'additional unstaged edit\n')
    writeFileSync(join(dir, 'user-config.txt'), 'untracked user config\n')
    const staged = git('diff', '--cached', '--binary')
    const work = git('diff', '--binary', '--', 'user-notes.md', 'user-staged.md')
    writeFileSync(join(dir, 'memory', 'TODAY.md'), 'consolidation started\n')
    writeFileSync(join(dir, 'memory', 'daily', `${dateAgo(0)}.md`), 'verbatim archive\n')
    rmSync(join(dir, 'memory', 'daily', 'old.md'))
    scopedCommit(dir, dateAgo(0), boundary)
    assert.equal(git('diff', '--cached', '--binary'), staged)
    assert.equal(git('diff', '--binary', '--', 'user-notes.md', 'user-staged.md'), work)
    assert.match(git('status', '--short'), /\?\? user-config.txt/)
    assert.deepEqual(git('show', '--format=', '--name-only', 'HEAD').split('\n').sort(),
      ['memory/TODAY.md', `memory/daily/${dateAgo(0)}.md`, 'memory/daily/old.md'].sort())
    const head = git('rev-parse', 'HEAD')
    scopedCommit(dir, dateAgo(0), boundary)
    assert.equal(git('rev-parse', 'HEAD') === head, boundary !== 'final')
    assert.equal(git('diff', '--cached', '--binary'), staged)
  })
}

test('final marker leaves consumed JSON deletion uncommitted and never recreates it', t => {
  const { dir, git, checkpoint, pair } = history(t)
  checkpoint()
  pair()
  scopedCommit(dir, dateAgo(0), 'steps 10-12')
  rmSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.json`))
  scopedCommit(dir, dateAgo(0), 'final')
  assert.match(git('status', '--short'), /^D reports\/.*memory-consolidation.json/)
  assert.equal(git('diff', '--cached', '--name-only'), '')
  assert.equal(git('show', `HEAD:reports/${dateAgo(0)}-memory-consolidation.json`), '{"operationType":"consolidation"}')
  assert.equal(state(dir).status, 0, state(dir).stdout)
  assert.equal(guard(dir).status, 1)
})

test('documented mutation command commits before returning and keeps maintenance blocked until final verification', t => {
  const skill = readFileSync(join(repoRoot, 'skills/memory/consolidate/SKILL.md'), 'utf8')
  assert.doesNotMatch(skill, /git add -A/)
  const command = skill.match(/^bash "\$CLAUDE_CONFIG_DIR\/scripts\/consolidation-apply.sh" .+$/m)?.[0]
  assert.ok(command, 'skill must supply an executable mutation submission command')
  const { dir, git } = history(t)
  assert.equal(markerStart(dir).status, 0)
  const record = readFileSync(markerPath(dir))
  const manifest = join(dir, '.git', 'mutations.json')
  writeFileSync(manifest, JSON.stringify({ version: 1, baseline: git('rev-parse', 'HEAD'), validation: { alarms: [] },
    mutations: [{ op: 'write', path: 'memory/semantic/promotion.md', before: null, content: 'verified promotion\n' }] }))
  const result = spawnSync('bash', ['-c', command.replace('YYYY-MM-DD', dateAgo(0))], { cwd: dir, encoding: 'utf8', env: {
    ...process.env, CLAUDE_CONFIG_DIR: repoRoot, CONSOLIDATION_MANIFEST: manifest,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(git('show', 'HEAD:memory/semantic/promotion.md'), 'verified promotion')
  assert.match(git('log', '-1', '--format=%s'), /checkpoint .*step 5d$/)
  assert.equal(git('status', '--porcelain'), '')
  assert.deepEqual(readFileSync(markerPath(dir)), record)
  assert.equal(marker(dir, 'clear').status, 2)
  assert.match(guard(dir).stdout, /unfinished consolidation cycle/)
})

for (const stagedDeletion of [false, true]) {
  test(`consumption before final preserves JSON index state (staged deletion=${stagedDeletion})`, t => {
    const { dir, git, checkpoint, pair } = history(t)
    checkpoint()
    pair()
    scopedCommit(dir, dateAgo(0), 'steps 10-12')
    const json = `reports/${dateAgo(0)}-memory-consolidation.json`
    rmSync(join(dir, json))
    if (stagedDeletion) git('add', '--', json)
    const index = git('diff', '--cached', '--binary')
    scopedCommit(dir, dateAgo(0), 'final')
    assert.equal(git('diff', '--cached', '--binary'), index)
    assert.equal(git('show', `HEAD:${json}`), '{"operationType":"consolidation"}')
    assert.equal(state(dir).status, 0, state(dir).stdout)
  })
}

test('scoped commit handles pre-staged retention/ledger deletion and exact extra skill outputs', t => {
  const { dir, git, commit, pair } = history(t)
  mkdirSync(join(dir, 'memory', 'episodic'), { recursive: true })
  const ledger = `memory/episodic/consolidation-progress-${dateAgo(0)}.md`
  writeFileSync(join(dir, ledger), 'in progress\n')
  writeFileSync(join(dir, 'HEARTBEAT.md'), 'old tasks\n')
  git('add', '-A')
  commit('ledger and heartbeat')
  rmSync(join(dir, ledger))
  git('add', '--', ledger)
  writeFileSync(join(dir, 'HEARTBEAT.md'), 'migrated tasks\n')
  writeFileSync(join(dir, 'CLAUDE.md'), 'trimmed instructions\n')
  writeFileSync(join(dir, 'user-staged.md'), 'keep staged\n')
  git('add', '--', 'user-staged.md')
  const index = git('diff', '--cached', '--binary', '--', 'user-staged.md')
  pair()
  scopedCommit(dir, dateAgo(0), 'steps 10-12', ['HEARTBEAT.md', 'CLAUDE.md'])
  assert.equal(git('diff', '--cached', '--binary', '--', 'user-staged.md'), index)
  assert.deepEqual(git('show', '--format=', '--name-only', 'HEAD').split('\n').sort(), [
    'CLAUDE.md', 'HEARTBEAT.md', ledger,
    `reports/${dateAgo(0)}-memory-consolidation.json`, `reports/${dateAgo(0)}-memory-consolidation.md`,
  ].sort())
})

for (const extra of ['user-notes.md', 'scripts/', 'scripts/../user-notes.md', 'scripts/*', ':(top)*']) {
  test(`scoped helper rejects non-exact/non-output extra path: ${extra}`, t => {
    const { dir, git } = history(t)
    const head = git('rev-parse', 'HEAD')
    const result = spawnSync('bash', [join(repoRoot, 'scripts/consolidation-commit.sh'), dir, dateAgo(0), 'step 0', extra], { encoding: 'utf8' })
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.equal(git('rev-parse', 'HEAD'), head)
  })
}

test('report pair in an unrelated earlier commit cannot substitute for Step 12a evidence', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  pair()
  git('add', '--', 'reports')
  commit('unrelated report files')
  checkpoint()
  rmSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.json`))
  git('add', '--', 'reports')
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  assert.equal(state(dir).status, 1)
  assert.match(guard(dir).stdout, /unfinished consolidation cycle/)
})

test('today report draft cannot be hidden by a completed prior cycle', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint(dateAgo(1))
  pair(dateAgo(1))
  git('add', '--', 'reports')
  commit(`chore: consolidate memory (${dateAgo(1)})`)
  pair()
  git('add', '--', 'reports')
  commit('unfinished report for today')
  assert.equal(state(dir).status, 1)
  assert.match(guard(dir).stdout, /unfinished consolidation cycle/)
})

test('detached HEAD, prior-day checkpoint and absent reports directory still block maintenance', t => {
  const { dir, git, checkpoint } = history(t)
  checkpoint(dateAgo(1))
  git('checkout', '--detach', '-q')
  rmSync(join(dir, 'reports'), { recursive: true })
  assert.equal(state(dir).status, 1)
  assert.match(guard(dir).stdout, /unfinished consolidation cycle/)
})

test('stale in-progress ledger does not override a committed prior-day completion', t => {
  const { dir, git, checkpoint, pair, commit } = history(t)
  checkpoint(dateAgo(1))
  pair(dateAgo(1))
  mkdirSync(join(dir, 'memory', 'episodic'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'episodic', `consolidation-progress-${dateAgo(1)}.md`), 'in progress\n')
  git('add', '-A')
  commit(`chore: consolidate memory (${dateAgo(1)})`)
  assert.equal(state(dir).status, 0, state(dir).stdout)
  assert.match(state(dir).stdout, /complete/)
})

// #506: the durable marker covers mutations before the first checkpoint.
function marker(dir, action, date, overrides = {}) {
  return spawnSync('bash', [join(repoRoot, 'scripts/consolidation-marker.sh'), action, dir, ...(date ? [date] : [])], {
    encoding: 'utf8', env: { ...process.env, ...overrides },
  })
}
const markerStart = (dir, date) => marker(dir, 'start', date)
const markerPath = dir => join(dir, '.git', 'consolidation-start')

for (const kind of ['malformed', 'unfinished']) {
  test(`audited repair preserves ${kind} marker bytes and unblocks a fresh start`, t => {
    const { dir, git } = history(t)
    const path = markerPath(dir)
    if (kind === 'unfinished') assert.equal(markerStart(dir).status, 0)
    const broken = kind === 'unfinished' ? readFileSync(path) : Buffer.from('v1 interrupted\0\n')
    writeFileSync(path, broken)
    if (kind === 'unfinished') assert.notEqual(guard(dir).status, 0)
    const capture = join(dir, '.git', 'marker-inspect.txt')
    const notes = join(dir, '.git', 'marker-review.txt')
    writeFileSync(capture, marker(dir, 'inspect').stdout)
    writeFileSync(notes, 'Archives inspected: TODAY.md and daily archives unchanged; no Step 0 writes\nReports inspected: git status/log and reports show only completed prior cycles\n')
    const before = { head: git('rev-parse', 'HEAD'), index: readFileSync(join(dir, '.git', 'index')), status: git('status', '--porcelain') }
    const result = spawnSync('bash', [join(repoRoot, 'scripts/consolidation-marker.sh'), 'repair', dir, capture, notes], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /repaired.*\.broken/)
    const backup = readdirSync(join(dir, '.git')).find(name => /consolidation-start\..*\.broken$/.test(name))
    assert.ok(backup)
    assert.deepEqual(readFileSync(join(dir, '.git', backup)), broken)
    const audit = readFileSync(join(dir, '.git', `${backup}.audit`), 'utf8')
    assert.ok(audit.includes(readFileSync(capture, 'utf8').trim()))
    assert.ok(audit.includes(readFileSync(notes, 'utf8').trim()))
    assert.match(readFileSync(`${path}.repair.log`, 'utf8'), /repaired.*\.broken/)
    assert.equal(git('rev-parse', 'HEAD'), before.head)
    assert.deepEqual(readFileSync(join(dir, '.git', 'index')), before.index)
    assert.equal(git('status', '--porcelain'), before.status)
    assert.equal(marker(dir, 'inspect').status, 0)
    assert.equal(marker(dir, 'start').status, 0)
  })
}

for (const kind of ['malformed', 'unfinished']) {
  for (const blocked of ['no capture', 'wrong capture', 'no archive review', 'no report review']) {
    test(`repair of ${kind} marker fails closed with ${blocked}`, t => {
      const { dir } = history(t)
      if (kind === 'unfinished') assert.equal(markerStart(dir).status, 0)
      else writeFileSync(markerPath(dir), 'truncated\n')
      const capture = join(dir, '.git', 'inspect.txt'), notes = join(dir, '.git', 'review.txt')
      if (blocked !== 'no capture') writeFileSync(capture, blocked === 'wrong capture' ? 'not the inspection\n' : marker(dir, 'inspect').stdout)
      writeFileSync(notes, [
        blocked === 'no archive review' ? '' : 'Archives inspected: compared TODAY and daily archives with git',
        blocked === 'no report review' ? '' : 'Reports inspected: checked drafts, committed reports and final history',
      ].join('\n') + '\n')
      const before = readFileSync(markerPath(dir))
      const result = spawnSync('bash', [join(repoRoot, 'scripts/consolidation-marker.sh'), 'repair', dir, capture, notes], { encoding: 'utf8' })
      assert.equal(result.status, 2, result.stdout + result.stderr)
      assert.deepEqual(readFileSync(markerPath(dir)), before)
      assert.equal(readdirSync(join(dir, '.git')).filter(name => name.endsWith('.broken')).length, 0)
    })
  }
}

function asyncGuard(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(repoRoot, 'scripts/maintenance-guard.sh'), dir])
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

for (const version of ['v1', 'v2']) {
  test(`unfinished ${version} marker refuses every guard, including two concurrent guards`, async t => {
    const { dir, git } = history(t)
    assert.equal(markerStart(dir).status, 0)
    // Continue to recognize existing v2 records, without using their metadata.
    if (version === 'v2') writeFileSync(markerPath(dir), `v2 ${dateAgo(0)} ${git('rev-parse', 'HEAD')} prior-session 123 prior-host 1\n`)
    const before = readFileSync(markerPath(dir))
    const results = [state(dir), guard(dir), ...await Promise.all([asyncGuard(dir), asyncGuard(dir)])]
    for (const result of results) {
      assert.notEqual(result.status, 0, result.stdout)
      assert.match(result.stdout, /unfinished consolidation cycle — inspect, then run `consolidation-marker.sh repair`/)
      assert.doesNotMatch(result.stdout, /consolidation_resume: true|consolidation_needed: true/)
      assert.equal(result.stderr, '')
    }
    assert.equal(markerStart(dir).status, 2)
    assert.deepEqual(readFileSync(markerPath(dir)), before)
    assert.deepEqual(readdirSync(join(dir, '.git')).filter(name => name.startsWith('consolidation-start')), ['consolidation-start'])
  })
}

for (const localFinal of [false, true]) {
  test(`merged pre-start branch cannot complete local marker (local final=${localFinal})`, t => {
    const { dir, git, pair, commit } = history(t)
    git('branch', 'other-clone')
    commit('local session before consolidation start')
    const local = git('rev-parse', 'HEAD')
    assert.equal(marker(dir, 'start').status, 0)
    const record = readFileSync(markerPath(dir))
    git('checkout', '-q', 'other-clone')
    pair()
    git('add', '--', 'reports')
    commit(`chore: consolidate memory checkpoint (${dateAgo(0)}) — steps 10-12`)
    commit(`chore: consolidate memory (${dateAgo(0)})`)
    git('checkout', '--detach', '-q', local)
    git('merge', '--no-ff', '-m', 'merge other clone reports', 'other-clone')
    if (localFinal) commit(`chore: consolidate memory (${dateAgo(0)})`)
    assert.notEqual(state(dir).status, 0, state(dir).stdout)
    assert.equal(marker(dir, 'clear').status, 2)
    assert.deepEqual(readFileSync(markerPath(dir)), record)
  })
}

for (const newestDaysAgo of [0, 3]) {
  test(`pre-0a interruption overrides ${newestDaysAgo === 0 ? 'recent-run' : 'idle'} suppression without changing existing work`, t => {
    const { dir, git } = history(t, { newestDaysAgo, today: '# source log\n- original entry\n' })
    assert.equal(guard(dir).status, 1)
    const head = git('rev-parse', 'HEAD')
    const index = readFileSync(join(dir, '.git', 'index'))
    assert.equal(markerStart(dir).status, 0)
    assert.equal(marker(dir, 'inspect').stdout, `v1 ${dateAgo(0)} ${head}\n`)
    assert.equal(git('status', '--porcelain'), '') // metadata is never staged
    assert.deepEqual(readFileSync(join(dir, '.git', 'index')), index)
    // Simulate kill after archive/reset, before 0a or any report/checkpoint.
    mkdirSync(join(dir, 'memory', 'daily'))
    const archive = join(dir, 'memory', 'daily', `${dateAgo(0)}.md`)
    writeFileSync(archive, '# source log\n- original entry\n')
    writeFileSync(join(dir, 'memory', 'TODAY.md'), '# reset\n- memory consolidation started\n')
    writeFileSync(join(dir, 'user-staged.md'), 'unrelated staged work\n')
    git('add', '--', 'user-staged.md')
    writeFileSync(join(dir, 'user-staged.md'), 'unrelated unstaged work\n')
    const before = {
      status: git('status', '--porcelain'), index: readFileSync(join(dir, '.git', 'index')),
      diff: git('diff', '--binary'), marker: readFileSync(markerPath(dir)),
    }
    for (let wake = 0; wake < 2; wake++) {
      const result = guard(dir, { CONSOLIDATION_WINDOW_START: '24', CONSOLIDATION_WINDOW_END: '25' })
      assert.notEqual(result.status, 0, result.stdout)
      assert.match(result.stdout, /unfinished consolidation cycle.*consolidation-marker.sh repair/)
      assert.doesNotMatch(result.stdout, /consolidation_needed/)
      assert.equal(state(dir).status, 1)
      assert.equal(marker(dir, 'clear').status, 2)
      assert.equal(marker(dir, 'start').status, 2)
    }
    assert.equal(git('status', '--porcelain'), before.status)
    assert.deepEqual(readFileSync(join(dir, '.git', 'index')), before.index)
    assert.equal(git('diff', '--binary'), before.diff)
    assert.deepEqual(readFileSync(markerPath(dir)), before.marker)
    assert.equal(readFileSync(archive, 'utf8'), '# source log\n- original entry\n')
    assert.equal(readFileSync(join(dir, 'memory', 'TODAY.md'), 'utf8'), '# reset\n- memory consolidation started\n')
    assert.equal(git('rev-parse', 'HEAD'), head)
  })
}

for (const daysAgo of [0, 1]) {
  test(`previous completed cycle cannot hide a new start marker (${daysAgo === 0 ? 'same date' : 'UTC rollover'})`, t => {
    const { dir, git, checkpoint, pair, commit } = history(t)
    const cycleDate = dateAgo(daysAgo)
    checkpoint(cycleDate)
    pair(cycleDate)
    git('add', '--', 'reports')
    commit(`chore: consolidate memory (${cycleDate})`)
    assert.match(state(dir).stdout, /consolidation_state: complete/)
    assert.equal(markerStart(dir, cycleDate).status, 0)
    const result = guard(dir)
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout, new RegExp(`${cycleDate}.*unfinished consolidation cycle.*consolidation-marker.sh repair`))
    assert.equal(marker(dir, 'clear').status, 2)
    assert.equal(marker(dir, 'inspect').status, 1)
  })
}

for (const corrupt of ['empty', 'truncated', 'version', 'date', 'extra line', 'binary', 'directory', 'unreadable']) {
  test(`malformed/unreadable marker (${corrupt}) blocks a fresh cycle before recent cadence`, t => {
    const { dir, git } = history(t, { newestDaysAgo: 0 })
    const path = markerPath(dir)
    const valid = `v1 ${dateAgo(0)} ${git('rev-parse', 'HEAD')}\n`
    const records = {
      empty: '', truncated: `v1 ${dateAgo(0)}\n`, version: valid.replace('v1', 'v2'),
      date: valid.replace(dateAgo(0), '2026-02-31'), 'extra line': valid + '\n', binary: valid + '\0',
    }
    const overrides = {}
    if (corrupt === 'directory') mkdirSync(path)
    else writeFileSync(path, records[corrupt] ?? valid)
    // Deterministically simulate an I/O failure even when tests run as root.
    if (corrupt === 'unreadable') {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const actualCat = spawnSync('which', ['cat'], { encoding: 'utf8' }).stdout.trim()
      writeFileSync(join(bin, 'cat'), `#!/bin/bash\ncase "$1" in *consolidation-start) exit 1;; esac\nexec '${actualCat}' "$@"\n`, { mode: 0o755 })
      overrides.PATH = `${bin}:${process.env.PATH}`
    }
    const before = git('status', '--porcelain')
    const result = guard(dir, overrides)
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout, /consolidation_inspect: true.*(malformed|unreadable|cannot read).*do not start a fresh cycle/)
    assert.doesNotMatch(result.stdout, /consolidation_needed/)
    assert.equal(marker(dir, 'start', undefined, overrides).status, 2)
    const clearance = marker(dir, 'clear', undefined, overrides)
    assert.equal(clearance.status, 2)
    assert.match(clearance.stdout, /inspect required.*no valid start marker to clear/)
    assert.equal(git('status', '--porcelain'), before)
    if (corrupt !== 'directory') assert.equal(readFileSync(path, 'utf8'), records[corrupt] ?? valid)
  })
}

for (const consumption of ['present', 'deleted before final', 'deletion committed before final']) {
  test(`marker clears only after its verified final/report evidence (${consumption}) across UTC rollover`, t => {
    const { dir, git, pair, commit } = history(t)
    const cycleDate = dateAgo(1)
    assert.equal(marker(dir, 'start', cycleDate).status, 0)
    assert.equal(marker(dir, 'clear').status, 2)
    pair(cycleDate)
    assert.equal(marker(dir, 'clear').status, 2) // drafts alone do not finish
    git('add', '--', 'reports')
    commit(`chore: consolidate memory checkpoint (${cycleDate}) — steps 10-12`)
    assert.equal(marker(dir, 'clear').status, 2) // checkpoint alone does not finish
    if (consumption !== 'present') rmSync(join(dir, 'reports', `${cycleDate}-memory-consolidation.json`))
    if (consumption.startsWith('deletion committed')) { git('add', '--', 'reports'); commit('consume JSON') }
    commit(`chore: consolidate memory (${dateAgo(0)})`)
    assert.equal(marker(dir, 'clear').status, 2) // final must match marker date
    commit(`chore: consolidate memory (${cycleDate})`)
    const record = readFileSync(markerPath(dir))
    assert.equal(state(dir).status, 0, state(dir).stdout)
    assert.match(state(dir).stdout, /consolidation_state: complete/)
    assert.deepEqual(readFileSync(markerPath(dir)), record) // detection never clears
    const index = readFileSync(join(dir, '.git', 'index'))
    const result = marker(dir, 'clear')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /cleared.*verified final commit\/report evidence/)
    assert.deepEqual(readFileSync(join(dir, '.git', 'index')), index)
    assert.equal(marker(dir, 'inspect').status, 0)
    assert.equal(state(dir).status, 0)
  })
}

for (const missing of ['md', 'json']) {
  test(`start marker cannot clear when final lacks committed ${missing} evidence`, t => {
    const { dir, git, pair, commit } = history(t)
    assert.equal(markerStart(dir).status, 0)
    pair()
    rmSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.${missing}`))
    git('add', '--', 'reports')
    commit(`chore: consolidate memory (${dateAgo(0)})`)
    assert.equal(marker(dir, 'clear').status, 2)
    assert.match(guard(dir).stdout, /unfinished consolidation cycle.*consolidation-marker.sh repair/)
  })
}

test('final pair without intermediate checkpoints verifies marker completion, but report edits block clearance', t => {
  const { dir, git, pair, commit } = history(t)
  assert.equal(markerStart(dir).status, 0)
  pair()
  git('add', '--', 'reports')
  commit(`chore: consolidate memory (${dateAgo(0)})`)
  assert.equal(guard(dir).status, 1)
  writeFileSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.md`), 'unfinished revision\n')
  assert.equal(marker(dir, 'clear').status, 2)
  assert.match(guard(dir).stdout, /unfinished consolidation cycle.*consolidation-marker.sh repair/)
  writeFileSync(join(dir, 'reports', `${dateAgo(0)}-memory-consolidation.md`), zeroPromotion)
  assert.equal(marker(dir, 'clear').status, 0)
})

test('unavailable marker HEAD and abandoned writer lock fail closed without repair', t => {
  const { dir } = history(t, { newestDaysAgo: 0 })
  writeFileSync(markerPath(dir), `v1 ${dateAgo(0)} ${'0'.repeat(40)}\n`)
  assert.equal(state(dir).status, 2)
  assert.equal(marker(dir, 'clear').status, 2)
  assert.match(guard(dir).stdout, /consolidation_inspect: true.*start marker HEAD/)
  rmSync(markerPath(dir))
  mkdirSync(`${markerPath(dir)}.lock`)
  assert.match(guard(dir).stdout, /consolidation_inspect: true.*lifecycle lock/)
  assert.equal(marker(dir, 'start').status, 2)
  // inspect/guard never remove the lock or create a marker.
  assert.equal(marker(dir, 'inspect').status, 2)
})

test('marker start refuses unfinished legacy checkpoints and invalid dates', t => {
  const { dir, checkpoint } = history(t)
  assert.equal(marker(dir, 'start', '2026-02-31').status, 2)
  assert.equal(marker(dir, 'inspect').status, 0)
  checkpoint()
  assert.equal(marker(dir, 'start').status, 2)
  assert.equal(marker(dir, 'inspect').status, 0)
})

test('linked worktrees have independent durable markers', t => {
  const { dir, git } = history(t)
  const linked = join(dir, 'linked')
  git('worktree', 'add', '--detach', linked, 'HEAD')
  assert.equal(markerStart(linked).status, 0)
  assert.equal(marker(linked, 'inspect').status, 1)
  assert.equal(marker(dir, 'inspect').status, 0)
  assert.match(guard(linked).stdout, /unfinished consolidation cycle.*consolidation-marker.sh repair/)
})


test('failed atomic publication leaves logs, archives, index and history untouched', t => {
  const { dir, git } = history(t, { today: '# original log\n' })
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'mv'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
  const head = git('rev-parse', 'HEAD')
  const index = readFileSync(join(dir, '.git', 'index'))
  const result = marker(dir, 'start', undefined, { PATH: `${bin}:${process.env.PATH}` })
  assert.equal(result.status, 2, result.stdout)
  assert.match(result.stdout, /cannot publish start marker.*do not start a fresh cycle/)
  assert.deepEqual(readdirSync(join(dir, 'memory')), ['TODAY.md'])
  assert.equal(readFileSync(join(dir, 'memory', 'TODAY.md'), 'utf8'), '# original log\n')
  assert.deepEqual(readFileSync(join(dir, '.git', 'index')), index)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.deepEqual(readdirSync(join(dir, '.git')).filter(name => name.startsWith('consolidation-start')), [])
  assert.equal(marker(dir, 'start').status, 0)
})

test('maintenance and direct skill entry require marker before initial log/archive mutation', () => {
  const maintenance = readFileSync(join(repoRoot, 'MAINTENANCE.md'), 'utf8')
  const skill = readFileSync(join(repoRoot, 'skills/memory/consolidate/SKILL.md'), 'utf8')
  assert.ok(maintenance.indexOf('consolidation-marker.sh" start .') < maintenance.indexOf('scripts/log-write.ts'))
  assert.ok(skill.indexOf('consolidation-marker.sh" start .') < skill.indexOf('### 0. Archive TODAY.md'))
  assert.ok(skill.indexOf('consolidation-marker.sh" clear .') > skill.indexOf('consolidation-commit.sh" . YYYY-MM-DD final'))
})
