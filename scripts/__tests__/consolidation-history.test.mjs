// Run with Node; fixtures use real Git trees and the production helper/validator.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
const archiveFor = date => `memory/episodic/archive/consolidation-history-${date.slice(0, 4)}-H${Number(date.slice(5, 7)) <= 6 ? 1 : 2}.md`
const entry = (date, start, work = 'Reviewed all memory tiers; zero promotions; regenerated SUMMARY.md.') =>
  `\n## Consolidation ${date} / ${start}\nStatus: in progress\nWork performed: ${work}\n<!-- /consolidation-history -->\n`
function fixture(t, date = '2026-11-14', previous = '# Previous archive\n\nHistorical bytes: café.\n') {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-history-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = (command, args) => spawnSync(command, args, { cwd: dir, env, encoding: 'utf8' })
  const git = (...args) => {
    const r = run('git', args)
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const shell = (name, ...args) => run('bash', [join(root, `scripts/consolidation-${name}.sh`), ...args])
  const put = (path, bytes) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), bytes) }
  git('init', '-q')
  const archive = archiveFor(date)
  if (previous !== null) put(archive, previous)
  put('user.md', 'original user content\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  const start = git('rev-parse', 'HEAD')
  const mark = join(dir, git('rev-parse', '--git-path', 'consolidation-start'))
  assert.equal(shell('marker', 'start', dir, date).status, 0)
  const json = `reports/${date}-memory-consolidation.json`
  const report = (metadata = { version: 1, cycleDate: date, startingHead: start }) => {
    put(`reports/${date}-memory-consolidation.md`, '# Reviewed tiers: zero promotions\n')
    put(json, JSON.stringify({ operationType: 'consolidation', ...(metadata === null ? {} : { consolidationHistory: metadata }) }) + '\n')
  }
  const append = () => put(archive, (previous || '') + entry(date, start))
  const validate = (...args) => run(process.execPath, [join(root, 'scripts/consolidation-history.mjs'), dir, date, ...args])
  const commit = boundary => shell('commit', dir, date, boundary)
  const state = () => shell('state', dir)
  const snapshot = () => ({ head: git('rev-parse', 'HEAD'), index: readFileSync(join(dir, '.git/index')), marker: readFileSync(mark) })
  const rejected = boundary => {
    const before = snapshot()
    const r = commit(boundary)
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /consolidation_history: blocked/)
    assert.ok(r.stderr.includes(archive), r.stderr)
    assert.ok(r.stderr.includes(`${date} / ${start}`), r.stderr)
    assert.deepEqual(snapshot(), before)
    return r
  }
  return { dir, git, shell, put, start, archive, previous, json, date, mark, report, append, validate, commit, state, snapshot, rejected }
}

for (const boundary of ['steps 5-6', 'steps 10-12', 'final']) {
  for (const bad of ['missing', 'wrong bucket', 'wrong date', 'wrong identity', 'date-only prose', 'empty record', 'prior same-day cycle', 'rewritten prefix', 'duplicate', 'completed status', 'invalid UTF-8', 'unreadable', 'symlink']) {
    test(`${boundary} rejects ${bad} without changing HEAD, index or marker`, t => {
      const f = fixture(t)
      f.report()
      f.put('user.md', 'staged user content\n'); f.git('add', '--', 'user.md')
      f.put('user.md', 'additional unstaged content\n')
      const valid = f.previous + entry(f.date, f.start)
      if (bad === 'missing') rmSync(join(f.dir, f.archive))
      if (bad === 'wrong bucket') f.put(f.archive.replace('-H2', '-H1'), valid)
      if (bad === 'wrong date') f.put(f.archive, f.previous + entry('2026-11-13', f.start))
      if (bad === 'wrong identity' || bad === 'prior same-day cycle') f.put(f.archive, f.previous + entry(f.date, 'a'.repeat(40)))
      if (bad === 'date-only prose') f.put(f.archive, f.previous + `Mentioned consolidation ${f.date} / ${f.start} in prose.\n`)
      if (bad === 'empty record') f.put(f.archive, f.previous + entry(f.date, f.start, ''))
      if (bad === 'rewritten prefix') f.put(f.archive, '# Replaced old archive\n' + entry(f.date, f.start))
      if (bad === 'duplicate') f.put(f.archive, valid + entry(f.date, f.start))
      if (bad === 'completed status') f.put(f.archive, valid.replace('Status: in progress', 'Status: complete'))
      if (bad === 'invalid UTF-8') {
        const [before, after] = valid.split('regenerated')
        f.put(f.archive, Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]))
      }
      if (bad === 'unreadable') { rmSync(join(f.dir, f.archive)); mkdirSync(join(f.dir, f.archive)) }
      if (bad === 'symlink') { f.put('history-source.md', valid); rmSync(join(f.dir, f.archive)); symlinkSync(join(f.dir, 'history-source.md'), join(f.dir, f.archive)) }
      f.rejected(boundary)
      assert.equal(readFileSync(join(f.dir, 'user.md'), 'utf8'), 'additional unstaged content\n')
    })
  }
}

test('clean-tree final requires history before creating an empty commit', t => {
  const f = fixture(t)
  f.report(); f.git('add', '--', 'reports'); f.git('commit', '-qm', `chore: consolidate memory checkpoint (${f.date}) — steps 10-12`)
  assert.equal(f.git('status', '--porcelain'), '')
  f.rejected('final')
})

for (const previous of [null, '# Preserve this archive without a final newline: café']) {
  test(`valid zero-promotion append and Step 6a retry preserve bytes (new archive=${previous === null})`, t => {
    const f = fixture(t, '2026-11-14', previous)
    f.append()
    const bytes = readFileSync(join(f.dir, f.archive))
    const before = f.snapshot()
    assert.equal(f.validate().status, 0)
    assert.deepEqual(f.snapshot(), before)
    assert.equal(f.commit('steps 5-6').status, 0)
    const head = f.git('rev-parse', 'HEAD')
    assert.equal(f.commit('steps 5-6').status, 0) // protected record is reused
    assert.equal(f.git('rev-parse', 'HEAD'), head)
    assert.deepEqual(readFileSync(join(f.dir, f.archive)), bytes)
    f.report()
    assert.equal(f.validate('--report').status, 0)
    assert.equal(f.commit('steps 10-12').status, 0)
    assert.equal(f.git('status', '--porcelain'), '')
    assert.equal(f.commit('final').status, 0) // empty final still checks committed metadata
    assert.equal(f.state().status, 0, f.state().stdout)
    assert.match(f.state().stdout, /complete/)
    assert.equal(f.shell('marker', 'clear', f.dir).status, 0)
    assert.deepEqual(readFileSync(join(f.dir, f.archive)), bytes)
  })
}

for (const [date, wallDate] of [['2026-05-04', '2026-05-05'], ['2026-06-30', '2026-07-01'], ['2026-12-31', '2027-01-01']]) {
  test(`original UTC marker identity survives rollover ${date} to ${wallDate}`, t => {
    const f = fixture(t, date)
    f.append(); f.report()
    // A real later wall date is already sufficient; a date shim makes the
    // boundary explicit without changing the marker parser's date validation.
    const actualDate = spawnSync('which', ['date'], { encoding: 'utf8' }).stdout.trim()
    f.put('bin/date', `#!/bin/bash\nif [ "$*" = '-u +%F' ]; then echo '${wallDate}'; else exec '${actualDate}' "$@"; fi\n`)
    chmodSync(join(f.dir, 'bin/date'), 0o755)
    const result = spawnSync('node', [join(root, 'scripts/consolidation-history.mjs'), f.dir, date, '--report'], {
      encoding: 'utf8', env: { ...env, PATH: `${join(f.dir, 'bin')}:${env.PATH}`, TZ: 'Pacific/Kiritimati' },
    })
    assert.equal(result.status, 0, result.stderr)
    const wrong = f.shell('commit', f.dir, wallDate, 'steps 5-6')
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.stderr, /conflicts with original UTC marker date/)
    assert.equal(f.commit('steps 10-12').status, 0)
    assert.equal(f.commit('final').status, 0)
    assert.equal(f.state().status, 0, f.state().stdout)
  })
}

for (const phase of ['present', 'consumed', 'committed deletion']) {
  test(`final and state use committed v1 report metadata (${phase})`, t => {
    const f = fixture(t)
    f.append(); f.report()
    assert.equal(f.commit('steps 10-12').status, 0)
    if (phase !== 'present') rmSync(join(f.dir, f.json))
    if (phase === 'committed deletion') { f.git('add', '--', f.json); f.git('commit', '-qm', 'consume JSON') }
    f.put('user.md', 'unrelated staged\n'); f.git('add', '--', 'user.md')
    const index = f.git('diff', '--cached', '--binary')
    assert.equal(f.commit('final').status, 0)
    assert.equal(f.git('diff', '--cached', '--binary'), index)
    assert.equal(f.state().status, 0, f.state().stdout)
    assert.equal(existsSync(join(f.dir, f.json)), phase === 'present')
    assert.equal(f.shell('marker', 'clear', f.dir).status, 0)
    assert.equal(f.state().status, 0)
  })
}

test('uncommitted history cannot establish completion or clear the marker, even after a later commit', t => {
  const f = fixture(t)
  f.report(); f.git('add', '--', 'reports')
  f.git('commit', '-qm', `chore: consolidate memory checkpoint (${f.date}) — steps 10-12`)
  f.append()
  f.git('commit', '--allow-empty', '-qm', `chore: consolidate memory (${f.date})`)
  const before = f.snapshot()
  assert.equal(f.state().status, 1, f.state().stdout)
  assert.match(f.state().stdout, /consolidation_history: blocked/)
  assert.equal(f.shell('marker', 'clear', f.dir).status, 2)
  assert.deepEqual(f.snapshot(), before)
  f.git('add', '--', f.archive); f.git('commit', '-qm', 'late history cannot repair the final tree')
  assert.equal(f.state().status, 1)
})

for (const bad of [null, { version: 2 }, { version: 1, cycleDate: '2026-11-13', startingHead: 'a'.repeat(40) }]) {
  test(`new helpers reject absent/conflicting report metadata: ${JSON.stringify(bad)}`, t => {
    const f = fixture(t)
    f.append(); f.report(bad)
    f.rejected('steps 10-12')
    f.git('add', '-A'); f.git('commit', '-qm', `chore: consolidate memory checkpoint (${f.date}) — steps 10-12`)
    f.rejected('final')
  })
}

test('uncommitted metadata cannot upgrade a legacy committed report for the new final helper', t => {
  const f = fixture(t)
  f.append(); f.report(null)
  f.git('add', '-A'); f.git('commit', '-qm', `chore: consolidate memory checkpoint (${f.date}) — steps 10-12`)
  f.report()
  f.rejected('final')
})

test('legacy committed completion remains recognized without history or backfill', t => {
  const f = fixture(t)
  f.report(null)
  f.git('add', '--', 'reports'); f.git('commit', '-qm', `chore: consolidate memory checkpoint (${f.date}) — steps 10-12`)
  f.git('commit', '--allow-empty', '-qm', `chore: consolidate memory (${f.date})`)
  assert.equal(f.state().status, 0, f.state().stdout)
  assert.equal(f.shell('marker', 'clear', f.dir).status, 0)
  assert.equal(readFileSync(join(f.dir, f.archive), 'utf8'), f.previous)
})

test('prior same-day committed cycle does not satisfy the next cycle', t => {
  const f = fixture(t)
  f.append(); f.report()
  assert.equal(f.commit('steps 10-12').status, 0)
  assert.equal(f.commit('final').status, 0)
  assert.equal(f.shell('marker', 'clear', f.dir).status, 0)
  assert.equal(f.shell('marker', 'start', f.dir, f.date).status, 0)
  const before = f.snapshot()
  assert.notEqual(f.commit('steps 5-6').status, 0)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.state().status, 1)
})

for (const boundary of ['step 0', 'steps 1-4', 'step 5d']) {
  test(`earlier ${boundary} checkpoint remains usable without history`, t => {
    const f = fixture(t, '2026-11-14', null)
    f.put('memory/TODAY.md', 'in progress\n')
    assert.equal(f.commit(boundary).status, 0)
    assert.equal(f.state().status, 1)
  })
}

for (const checkpoint of [false, true]) {
  test(`committed v1 metadata cannot substitute for history after marker loss (checkpoint=${checkpoint})`, t => {
    const f = fixture(t, '2026-11-13', null)
    f.report()
    f.git('add', '--', 'reports')
    if (checkpoint) f.git('commit', '-qm', `chore: consolidate memory checkpoint (${f.date}) — steps 10-12`)
    f.git('commit', '--allow-empty', '-qm', `chore: consolidate memory (${f.date})`)
    // Model a clone with committed reports/final but no local lifecycle marker.
    rmSync(f.mark)
    const result = f.state()
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stdout, /missing\/unreadable regular file.*consolidation-history-2026-H2/)
  })
}

for (const metadata of [
  { version: 2, cycleDate: '2026-11-14', startingHead: 'a'.repeat(40) },
  { version: 1, cycleDate: '2026-11-14', startingHead: 'a'.repeat(40) },
]) {
  test(`committed conflicting/unsupported metadata blocks completion: ${JSON.stringify(metadata)}`, t => {
    const f = fixture(t)
    f.append(); f.report(metadata)
    f.git('add', '-A'); f.git('commit', '-qm', `chore: consolidate memory checkpoint (${f.date}) — steps 10-12`)
    f.git('commit', '--allow-empty', '-qm', `chore: consolidate memory (${f.date})`)
    assert.equal(f.state().status, 1)
    assert.equal(f.shell('marker', 'clear', f.dir).status, 2)
  })
}
