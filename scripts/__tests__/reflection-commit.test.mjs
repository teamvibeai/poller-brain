import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const script = join(root, 'scripts/reflection-commit.mjs')
const date = new Date().toISOString().slice(0, 10)
const episodic = `memory/episodic/reflection-${date}.md`
const markdown = `reports/${date}-memory-reflection.md`
const json = `reports/${date}-memory-reflection.json`
const reports = [episodic, markdown, json]
const target = 'memory/core/LEARNINGS.md'
const old = 'memory/semantic/old.md'
const destination = 'memory/episodic/archive/žluťoučký topic.md'
const reason = `Deleted ${old} — content preserved verbatim in ${destination}`

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflection-commit-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const brain = join(dir, 'brain')
  mkdirSync(brain)
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE']) delete env[key]
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: brain, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const write = (path, content) => {
    mkdirSync(dirname(join(brain, path)), { recursive: true })
    writeFileSync(join(brain, path), content)
  }
  git('init', '-q')
  for (const path of [target, old, 'memory/user.md', 'user.md']) write(path, 'original\n')
  git('add', '.')
  git('commit', '-qm', 'baseline')
  const baseline = git('rev-parse', 'HEAD')
  const manifest = join(dir, 'manifest.json')
  const savePlan = plan => writeFileSync(manifest, JSON.stringify(plan))
  const run = (boundary = 'checklist', plan = { paths: [target] }, overrides = {}) => {
    savePlan(plan)
    return spawnSync(process.execPath, [script, brain, date, boundary, manifest], { encoding: 'utf8', env: { ...env, ...overrides } })
  }
  const snapshot = () => ({ head: git('rev-parse', 'HEAD'), index: readFileSync(join(brain, '.git/index')),
    work: git('diff', '--binary'), status: git('status', '--porcelain=v1', '--untracked-files=all') })
  const evidence = () => JSON.parse(git('show', '-s', '--format=%B').split('\n').find(line => line.startsWith('Reflection-Evidence: ')).slice('Reflection-Evidence: '.length))
  return { dir, brain, env, git, write, run, savePlan, manifest, snapshot, baseline, evidence }
}

function passed(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}
function failed(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stdout, '', 'failure must never emit success evidence')
  assert.match(result.stderr, pattern)
  assert.match(result.stderr, /stop before report production\/finalization/)
}
function userWork(f) {
  for (const path of ['user.md', 'memory/user.md']) {
    f.write(path, 'staged user\n')
    f.git('add', path)
    f.write(path, 'unstaged user\n')
  }
  f.write('untracked.md', 'keep untracked\n')
  return { staged: f.git('diff', '--cached', '--binary'), unstaged: f.git('diff', '--binary') }
}
function assertUserWork(f, before) {
  assert.equal(f.git('diff', '--cached', '--binary'), before.staged)
  assert.equal(f.git('diff', '--binary'), before.unstaged)
  assert.equal(readFileSync(join(f.brain, 'untracked.md'), 'utf8'), 'keep untracked\n')
}

test('interruption after checklist leaves committed content and durable evidence without completing cadence', t => {
  const f = fixture(t)
  const user = userWork(f)
  f.write(target, 'reviewed reflection\n')
  copyFileSync(join(f.brain, old), join(f.dir, 'preserved-copy'))
  f.write(destination, readFileSync(join(f.dir, 'preserved-copy')))
  rmSync(join(f.brain, old))
  const result = passed(f.run('checklist', { paths: [target, old, destination], deletionPreservation: { [old]: reason } }))
  assert.equal(result.result, 'committed')
  assert.equal(f.git('log', '-1', '--format=%s'), `chore: memory reflection checkpoint (${date}) — checklist`)
  assert.equal(f.git('rev-parse', 'HEAD^'), f.baseline)
  assert.equal(f.git('show', `HEAD:${target}`), 'reviewed reflection')
  assert.deepEqual(f.evidence().deletionPreservation, { [old]: reason })
  assert.deepEqual(f.evidence().filesChanged.sort(), [target, old, destination].sort())
  assert.equal(f.git('show', 'HEAD:' + destination), 'original')
  for (const path of reports) assert.equal(existsSync(join(f.brain, path)), false)
  assertUserWork(f, user)
  const guard = spawnSync('bash', [join(root, 'scripts/reflection-guard.sh'), f.brain], { env: f.env, encoding: 'utf8' })
  assert.equal(guard.status, 0, guard.stdout + guard.stderr)
  assert.match(guard.stdout, /"lastReflectionDate":null/)
  assert.match(guard.stdout, /"isOverdue":true/)
  assert.equal(passed(f.run('checklist', { paths: [target, old, destination], deletionPreservation: { [old]: reason } })).result, 'no-change')
  assert.equal(f.git('rev-parse', 'HEAD'), result.commit)
  // Recover bookkeeping exclusively from committed evidence, as after a restart.
  const saved = f.evidence()
  const checkpoint = f.git('rev-parse', 'HEAD')
  const report = { operationType: 'reflection', filesChanged: [...saved.filesChanged, ...reports],
    operationCounts: { created: 4, modified: 1, deleted: 1 }, decisions: Object.values(saved.deletionPreservation) }
  f.write(episodic, '# Memory Reflection\n\n## Changes Made\n' + saved.filesChanged.join('\n') + '\n' + reason + '\n')
  f.write(markdown, '# Reflection\n' + saved.filesChanged.join('\n') + '\n' + reason + '\n')
  f.write(json, JSON.stringify(report) + '\n')
  const final = passed(f.run('final', { paths: reports }))
  assert.equal(final.result, 'committed')
  assert.equal(f.git('log', '-1', '--format=%s'), `chore: memory reflection (${date})`)
  assert.equal(f.git('rev-parse', 'HEAD^'), checkpoint)
  assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), reports.slice().sort())
  assert.deepEqual(JSON.parse(f.git('show', `HEAD:${json}`)), report)
  assertUserWork(f, user)
  const completed = spawnSync('bash', [join(root, 'scripts/reflection-guard.sh'), f.brain], { env: f.env, encoding: 'utf8' })
  assert.equal(completed.status, 1, completed.stdout + completed.stderr)
  assert.match(completed.stdout, new RegExp(`"lastReflectionDate":"${date}"`))
  assert.equal(passed(f.run('final', { paths: reports })).result, 'no-change')
  assert.equal(f.git('rev-parse', 'HEAD'), final.commit)
})

test('genuine no-change and empty review do not create commits or alter the real index', t => {
  const f = fixture(t)
  userWork(f)
  const before = f.snapshot()
  for (const paths of [[target], [], ['memory/absent.md']]) {
    assert.equal(passed(f.run('checklist', { paths })).result, 'no-change')
    assert.deepEqual(f.snapshot(), before)
  }
})

test('a staged reviewed target is rejected without consuming staged or unstaged bytes', t => {
  const f = fixture(t)
  f.write(target, 'staged\n')
  f.git('add', target)
  f.write(target, 'unstaged\n')
  const before = f.snapshot()
  failed(f.run(), /overlap staged work/)
  assert.deepEqual(f.snapshot(), before)
})

test('checkpoint cannot include reports or run with a premature cadence file', t => {
  const f = fixture(t)
  for (const path of reports) {
    f.write(path, 'premature\n')
    const before = f.snapshot()
    failed(f.run('checklist', { paths: [path] }), /before finalization|exact reflection path/)
    assert.deepEqual(f.snapshot(), before)
    rmSync(join(f.brain, path))
  }
  f.write(episodic, 'premature\n')
  failed(f.run(), /before finalization/)
})

test('final requires explicitly reviewed episodic and both maintenance reports', t => {
  const f = fixture(t)
  for (const path of reports) f.write(path, 'report\n')
  const before = f.snapshot()
  for (const omitted of reports) {
    failed(f.run('final', { paths: reports.filter(path => path !== omitted) }), /final requires reviewed report/)
    assert.deepEqual(f.snapshot(), before)
  }
  rmSync(join(f.brain, json))
  failed(f.run('final', { paths: reports }), /final requires reviewed report/)
})

test('missing deletion evidence stops the checkpoint without changing HEAD/index', t => {
  const f = fixture(t)
  rmSync(join(f.brain, old))
  const before = f.snapshot()
  failed(f.run('checklist', { paths: [old] }), /missing deletion preservation/)
  assert.deepEqual(f.snapshot(), before)
})

for (const command of ['commit-tree', 'update-ref']) {
  test(`${command} failure stops a shell sequence before report production and preserves all user work`, t => {
    const f = fixture(t)
    userWork(f)
    f.write(target, 'reviewed\n')
    const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
    const bin = join(f.dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/bash\nfor arg in "$@"; do\n  if [ "$arg" = '${command}' ]; then exit 42; fi\ndone\nexec '${actualGit}' "$@"\n`, { mode: 0o755 })
    f.savePlan({ paths: [target] })
    const before = f.snapshot()
    const r = spawnSync('bash', ['-c', 'set -e\n"$1" "$2" "$3" "$4" checklist "$5"\nprintf report > "$6"',
      'test', process.execPath, script, f.brain, date, f.manifest, join(f.brain, markdown)],
    { env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, encoding: 'utf8' })
    failed(r, new RegExp(`git ${command} failed`))
    assert.deepEqual(f.snapshot(), before)
    assert.equal(existsSync(join(f.brain, markdown)), false)
    assert.equal(existsSync(join(f.brain, '.git/index.lock')), false)
  })
}

for (const marker of ['', 'Owner disabled maintenance\n']) {
  test(`opt-out (${marker ? 'reason' : 'empty'}) does no writes, even with invalid arguments/manifest`, t => {
    const f = fixture(t)
    f.write('MAINTENANCE_DISABLED', marker)
    userWork(f)
    f.write(target, 'uncommitted reflection\n')
    const before = f.snapshot()
    const gitFiles = readdirSync(join(f.brain, '.git')).sort()
    for (const boundary of ['checklist', 'final']) {
      // Nonexistent TMPDIR would break scratch creation if the gate were late.
      const r = spawnSync(process.execPath, [script, f.brain, 'bad-date', boundary, join(f.dir, 'nonexistent')],
        { env: { ...f.env, TMPDIR: join(f.dir, 'nonexistent') }, encoding: 'utf8' })
      failed(r, /maintenance disabled; no writes performed/)
      assert.deepEqual(f.snapshot(), before)
      assert.deepEqual(readdirSync(join(f.brain, '.git')).sort(), gitFiles)
      assert.equal(readFileSync(join(f.brain, target), 'utf8'), 'uncommitted reflection\n')
    }
  })
}

for (const path of ['memory/', 'memory/../user.md', target + '/', 'memory/*.md', ':memory/core/x.md', 'user.md', 'reports/other-memory-reflection.md']) {
  test(`rejects unreviewable path ${path}`, t => {
    const f = fixture(t)
    const before = f.snapshot()
    failed(f.run('checklist', { paths: [path] }), /exact reflection path|unsafe reflection path/)
    assert.deepEqual(f.snapshot(), before)
  })
}

test('symlink path traversal and duplicate paths are rejected', t => {
  const f = fixture(t)
  symlinkSync(f.dir, join(f.brain, 'memory/link'))
  failed(f.run('checklist', { paths: ['memory/link/escape.md'] }), /unsafe reflection path/)
  failed(f.run('checklist', { paths: [target, target] }), /unique reviewed paths/)
})

test('an existing index lock is preserved on failure', t => {
  const f = fixture(t)
  f.write(target, 'reviewed\n')
  f.write('.git/index.lock', 'another operation\n')
  const before = f.snapshot()
  failed(f.run(), /EEXIST/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(readFileSync(join(f.brain, '.git/index.lock'), 'utf8'), 'another operation\n')
})

test('a subdirectory opt-out does not disable root reflection', t => {
  const f = fixture(t)
  f.write('memory/MAINTENANCE_DISABLED', '')
  f.write(target, 'reviewed\n')
  assert.equal(passed(f.run()).result, 'committed')
  assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), target)
})

test('hooks cannot edit unrelated work or prevent the isolated commit', t => {
  const f = fixture(t)
  const user = userWork(f)
  for (const hook of ['pre-commit', 'post-commit', 'post-index-change']) {
    f.write(`.git/hooks/${hook}`, '#!/bin/sh\nprintf corrupted > user.md\nexit 1\n')
    f.git('config', 'core.hooksPath', '.git/hooks')
    // Make hooks executable without adding them to the index.
    const r = spawnSync('chmod', ['+x', join(f.brain, '.git/hooks', hook)])
    assert.equal(r.status, 0)
  }
  f.write(target, 'reviewed\n')
  assert.equal(passed(f.run()).result, 'committed')
  // Disable the hostile hook for the assertions' own Git commands.
  f.git('config', 'core.hooksPath', '/dev/null')
  assertUserWork(f, user)
})
