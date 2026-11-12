import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
const date = '2026-11-12'
const hash = text => createHash('sha256').update(text).digest('hex')
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-apply-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '-q')
  mkdirSync(join(dir, 'memory/core'), { recursive: true })
  mkdirSync(join(dir, 'memory/semantic'))
  mkdirSync(join(dir, 'memory/daily'))
  writeFileSync(join(dir, 'memory/core/LEARNINGS.md'), 'original\n')
  writeFileSync(join(dir, 'memory/semantic/obsolete.md'), 'obsolete\n')
  writeFileSync(join(dir, 'memory/daily/2026-09-01.md'), 'old log\n')
  writeFileSync(join(dir, 'user.md'), 'original user\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD')
  const marker = join(dir, '.git/consolidation-start')
  writeFileSync(marker, `v1 ${date} ${head}\n`)
  const manifest = { version: 1, baseline: head, validation: { alarms: [] }, mutations: [
    { op: 'write', path: 'memory/core/LEARNINGS.md', before: hash('original\n'), content: 'promoted\n' },
  ] }
  const apply = (boundary = 'step 5d', overrides = {}, cycleDate = date) => spawnSync('bash', [join(root, 'scripts/consolidation-apply.sh'), dir, cycleDate, boundary], {
    env: { ...env, ...overrides }, input: JSON.stringify(manifest), encoding: 'utf8',
  })
  const snapshot = () => ({ head: git('rev-parse', 'HEAD'), index: readFileSync(join(dir, '.git/index')).toString('hex'),
    diff: git('diff', '--binary'), status: git('status', '--porcelain'), marker: readFileSync(marker).toString('hex') })
  return { dir, git, marker, manifest, apply, snapshot, env }
}

test('apply commits before success, preserves unrelated staged/worktree/untracked state, and retries without a commit', t => {
  const { dir, git, marker, apply } = fixture(t)
  writeFileSync(join(dir, 'user.md'), 'staged user\n')
  git('add', 'user.md')
  writeFileSync(join(dir, 'user.md'), 'unstaged user\n')
  writeFileSync(join(dir, 'untracked'), 'keep\n')
  // Unrelated memory is not swept into the exact-path checkpoint either.
  writeFileSync(join(dir, 'memory/user.md'), 'staged memory\n')
  git('add', 'memory/user.md')
  writeFileSync(join(dir, 'memory/user.md'), 'unstaged memory\n')
  const staged = git('diff', '--cached', '--binary')
  const work = git('diff', '--binary')
  const record = readFileSync(marker)
  const r = apply()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'memory/core/LEARNINGS.md')
  assert.equal(git('show', 'HEAD:memory/core/LEARNINGS.md'), 'promoted')
  assert.equal(git('diff', '--cached', '--binary'), staged)
  assert.equal(git('diff', '--binary'), work)
  assert.equal(readFileSync(join(dir, 'untracked'), 'utf8'), 'keep\n')
  assert.deepEqual(readFileSync(marker), record)
  const head = git('rev-parse', 'HEAD')
  assert.equal(apply().status, 0)
  assert.equal(git('rev-parse', 'HEAD'), head)
})

const failures = {
  'missing marker': f => rmSync(f.marker),
  'malformed marker': f => writeFileSync(f.marker, 'bad\n'),
  'binary marker': f => writeFileSync(f.marker, `v1 ${date} ${f.manifest.baseline}\n\0`),
  'invalid marker date': f => writeFileSync(f.marker, `v1 2026-02-31 ${f.manifest.baseline}\n`),
  'wrong cycle date': f => writeFileSync(f.marker, `v1 2026-11-11 ${f.manifest.baseline}\n`),
  'unavailable ancestry': f => writeFileSync(f.marker, `v1 ${date} ${'0'.repeat(40)}\n`),
  'nonancestor marker': f => {
    const other = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-m', 'orphan')
    writeFileSync(f.marker, `v1 ${date} ${other}\n`)
  },
  'lifecycle lock': f => mkdirSync(`${f.marker}.lock`),
  'baseline content conflict': f => { f.manifest.mutations[0].before = hash('wrong') },
  'worktree conflict': f => writeFileSync(join(f.dir, 'memory/core/LEARNINGS.md'), 'user work\n'),
  'staged conflict': f => { writeFileSync(join(f.dir, 'memory/core/LEARNINGS.md'), 'user staged\n'); f.git('add', 'memory'); writeFileSync(join(f.dir, 'memory/core/LEARNINGS.md'), 'original\n') },
  'stale baseline': f => { f.git('commit', '--allow-empty', '-qm', 'other work') },
  'validation alarm': f => { f.manifest.validation.alarms = ['MEM integrity unresolved'] },
  'missing validation': f => { delete f.manifest.validation },
  'whitespace validation alarm': f => { f.manifest.mutations[0].content = 'trailing space \n' },
  'no-op with wrong before hash': f => { f.manifest.mutations[0].content = 'original\n'; f.manifest.mutations[0].before = hash('wrong') },
  'nonancestor baseline': f => { f.manifest.baseline = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-m', 'orphan') },
  'index lock': f => writeFileSync(join(f.dir, '.git/index.lock'), 'existing lock\n'),
  'duplicate paths': f => { f.manifest.mutations.push({ ...f.manifest.mutations[0] }) },
  'unknown operation': f => { f.manifest.mutations[0].op = 'exec' },
  'commit hook failure': f => writeFileSync(join(f.dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }),
  'rewritten checkpoint subject': f => writeFileSync(join(f.dir, '.git/hooks/commit-msg'), '#!/bin/sh\nprintf "unrelated subject\\n" > "$1"\n', { mode: 0o755 }),
  'commit reports failure after publishing': f => {
    const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
    mkdirSync(join(f.dir, 'bin'))
    writeFileSync(join(f.dir, 'bin/git'), `#!/bin/bash\nif [ "$2" = commit ]; then '${actualGit}' "$@"; exit 1; fi\nexec '${actualGit}' "$@"\n`, { mode: 0o755 })
    f.env.PATH = `${join(f.dir, 'bin')}:${f.env.PATH}`
  },
}
for (const path of ['../outside.md', 'memory/../user.md', '/tmp/outside.md', 'user.md', 'memory//foo.md', 'memory/core/./x.md', 'memory/.git/config', 'memory/core/*.md']) {
  failures[`unsafe path ${path}`] = f => { f.manifest.mutations[0].path = path }
}
for (const component of ['memory', 'memory/core', 'memory/core/LEARNINGS.md']) {
  failures[`symlink ${component}`] = f => {
    const target = join(f.dir, 'link-target')
    if (component.endsWith('.md')) writeFileSync(target, 'original\n')
    else mkdirSync(target)
    rmSync(join(f.dir, component), { recursive: true })
    symlinkSync(target, join(f.dir, component))
  }
}
for (const [name, setup] of Object.entries(failures)) {
  test(`fails closed: ${name}`, t => {
    const f = fixture(t)
    setup(f)
    // The missing-marker case has no marker to snapshot.
    const record = name === 'missing marker' ? null : readFileSync(f.marker)
    const before = { head: f.git('rev-parse', 'HEAD'), index: readFileSync(join(f.dir, '.git/index')), status: f.git('status', '--porcelain'), diff: f.git('diff', '--binary') }
    const result = f.apply()
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stderr, /consolidation_(apply|commit):/)
    const expected = name.includes('marker') || name === 'unavailable ancestry' || name === 'wrong cycle date' ? /marker|ancestor|merge-base/ :
      name.includes('symlink') || name.includes('unsafe path') ? /unsafe memory path/ :
      name === 'commit hook failure' || name === 'commit reports failure after publishing' ? /git commit failed/ :
      name === 'rewritten checkpoint subject' ? /planned.*subject/ :
      name === 'index lock' || name === 'lifecycle lock' ? /EEXIST/ :
      name === 'whitespace validation alarm' ? /git diff failed/ :
      name === 'no-op with wrong before hash' ? /baseline content conflict/ :
      name.includes('baseline') || name === 'worktree conflict' || name === 'staged conflict' ? /baseline|merge-base/ :
      name.includes('validation') ? /validation/ : name === 'duplicate paths' ? /duplicate/ : /mutation/
    assert.match(result.stderr, expected)
    assert.equal(f.git('rev-parse', 'HEAD'), before.head)
    assert.deepEqual(readFileSync(join(f.dir, '.git/index')), before.index)
    assert.equal(f.git('status', '--porcelain'), before.status)
    assert.equal(f.git('diff', '--binary'), before.diff)
    if (record) assert.deepEqual(readFileSync(f.marker), record)
    if (name === 'index lock') assert.equal(readFileSync(join(f.dir, '.git/index.lock'), 'utf8'), 'existing lock\n')
  })
}

test('invalid input dates and unsupported steps fail before mutation', t => {
  const f = fixture(t)
  const before = f.snapshot()
  for (const invalid of ['2026-02-31', 'not-a-date']) assert.notEqual(f.apply('step 5d', {}, invalid).status, 0)
  for (const invalid of ['final', 'step 6', 'step 9', 'steps 1-4']) assert.notEqual(f.apply(invalid).status, 0)
  assert.deepEqual(f.snapshot(), before)
})

test('a failed batch restores writes, deletes, new files and directories, then supports an explicit retry', t => {
  const f = fixture(t)
  f.manifest.mutations.push(
    { op: 'delete', path: 'memory/semantic/obsolete.md', before: hash('obsolete\n') },
    { op: 'write', path: 'memory/episodic/archive/new.md', before: null, content: 'archive\n' },
  )
  const hook = join(f.dir, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const before = f.snapshot()
  assert.notEqual(f.apply('step 5c').status, 0)
  assert.deepEqual(f.snapshot(), before)
  assert.throws(() => readFileSync(join(f.dir, 'memory/episodic')), /ENOENT/)
  rmSync(hook)
  const r = f.apply('step 5c')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(f.git('show', '--format=', '--name-only', 'HEAD').split('\n').length, 3)
})

test('empty and unchanged submissions leave HEAD and index untouched', t => {
  const f = fixture(t)
  f.manifest.mutations[0].content = 'original\n'
  const before = f.snapshot()
  assert.equal(f.apply().status, 0)
  assert.deepEqual(f.snapshot(), before)
  f.manifest.mutations = []
  assert.equal(f.apply().status, 0)
  assert.deepEqual(f.snapshot(), before)
})

test('Steps 1–5d cannot bypass Step 7 retention by deleting a daily log', t => {
  const f = fixture(t)
  f.manifest.mutations = [{ op: 'delete', path: 'memory/daily/2026-09-01.md', before: hash('old log\n') }]
  const before = f.snapshot()
  const r = f.apply('step 1b')
  assert.notEqual(r.status, 0, r.stderr)
  assert.match(r.stderr, /step 7/)
  assert.deepEqual(f.snapshot(), before)
})

test('step 7 deletes only daily logs older than 30 days and retries idempotently', t => {
  const f = fixture(t)
  f.manifest.mutations = [{ op: 'delete', path: 'memory/daily/2026-09-01.md', before: hash('old log\n') }]
  const r = f.apply('step 7')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(f.git('show', '--format=', '--name-status', 'HEAD'), 'D\tmemory/daily/2026-09-01.md')
  const head = f.git('rev-parse', 'HEAD')
  assert.equal(f.apply('step 7').status, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
})

for (const [op, path] of [['write', 'memory/daily/2026-09-01.md'], ['delete', 'memory/core/LEARNINGS.md'], ['delete', 'memory/daily/2026-11-12.md'], ['delete', 'memory/daily/weekly-2026-11-01.md']]) {
  test(`step 7 rejects ${op} ${path}`, t => {
    const f = fixture(t)
    Object.assign(f.manifest.mutations[0], { op, path })
    assert.notEqual(f.apply('step 7').status, 0)
  })
}

test('strict memory-only commit rejects extras and preserves the real index on commit failure', t => {
  const f = fixture(t)
  writeFileSync(join(f.dir, 'memory/core/LEARNINGS.md'), 'checkpoint\n')
  for (const failure of ['outside path', 'hook']) {
    if (failure === 'hook') writeFileSync(join(f.dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const before = f.snapshot()
    const r = spawnSync('bash', [join(root, 'scripts/consolidation-commit.sh'), '--memory-only', f.dir, date, 'step 5d', failure === 'hook' ? 'memory/core/LEARNINGS.md' : 'user.md'], { env: f.env, encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('strict memory-only mode commits exact memory paths and preserves unrelated index and worktree state', t => {
  const f = fixture(t)
  writeFileSync(join(f.dir, 'user.md'), 'user staged\n')
  f.git('add', 'user.md')
  writeFileSync(join(f.dir, 'user.md'), 'user unstaged\n')
  mkdirSync(join(f.dir, 'reports'))
  writeFileSync(join(f.dir, 'reports', `${date}-memory-consolidation.md`), 'unsubmitted report\n')
  writeFileSync(join(f.dir, 'memory/other.md'), 'other memory\n')
  f.git('add', 'memory/other.md')
  const staged = f.git('diff', '--cached', '--binary')
  const work = f.git('diff', '--binary')
  const record = readFileSync(f.marker)
  writeFileSync(join(f.dir, 'memory/core/LEARNINGS.md'), 'strict checkpoint\n')
  const run = () => spawnSync('bash', [join(root, 'scripts/consolidation-commit.sh'), '--memory-only', f.dir, date, 'step 5d', 'memory/core/LEARNINGS.md'], { env: f.env, encoding: 'utf8' })
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'memory/core/LEARNINGS.md')
  assert.equal(f.git('diff', '--cached', '--binary'), staged)
  assert.equal(f.git('diff', '--binary'), work)
  assert.deepEqual(readFileSync(f.marker), record)
  const head = f.git('rev-parse', 'HEAD')
  assert.equal(run().status, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
})
