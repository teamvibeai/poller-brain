import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { renderInventory, tierInventory, verifyInventory } from '../mem-tier-inventory.mjs'

const script = fileURLToPath(new URL('../mem-tier-inventory.mjs', import.meta.url))
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const tiers = ['core', 'semantic', 'episodic', 'procedural']
const coverage = '## Tier Coverage\n' + tiers.map(tier => `- ${tier}/: No new content — confirmed ✅\n`).join('')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-tier-inventory-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const tier of tiers) mkdirSync(join(dir, 'memory', tier), { recursive: true })
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const cli = (...args) => spawnSync(process.execPath, [script, dir, ...args], { encoding: 'utf8' })
  return { dir, write, cli }
}

function blocked(result, pattern) {
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.equal(result.stdout, '', 'never emit a partial inventory on failure')
  assert.match(result.stderr, pattern)
}

test('inventories nested Markdown paths, UTF-8 bytes and all tier totals in stable order', t => {
  const f = fixture(t)
  f.write('memory/semantic/žluťoučký team/guide.md', 'Příliš 🧠\n')
  f.write('memory/core/z.md', 'last\n')
  f.write('memory/core/a/one.md', 'one\r\n')
  f.write('memory/core/a.md', 'first\n')
  f.write('memory/procedural/flow.md', '')
  f.write('memory/core/ignored.txt', 'not markdown')
  f.write('memory/daily/ignored.md', 'not a tier')
  f.write('memory/SUMMARY.md', 'not a tier')
  f.write('reports/ignored.md', 'not a tier')
  const result = tierInventory(f.dir)
  assert.deepEqual(result.tiers, [
    { tier: 'core', status: 'present', count: 3, bytes: 16, files: [
      { path: 'core/a.md', bytes: 6 }, { path: 'core/a/one.md', bytes: 5 }, { path: 'core/z.md', bytes: 5 },
    ] },
    { tier: 'semantic', status: 'present', count: 1, bytes: Buffer.byteLength('Příliš 🧠\n'), files: [
      { path: 'semantic/žluťoučký team/guide.md', bytes: Buffer.byteLength('Příliš 🧠\n') },
    ] },
    { tier: 'episodic', status: 'empty', count: 0, bytes: 0, files: [] },
    { tier: 'procedural', status: 'present', count: 1, bytes: 0, files: [{ path: 'procedural/flow.md', bytes: 0 }] },
  ])
  assert.equal(result.totalFiles, 5)
  assert.equal(result.totalBytes, 16 + Buffer.byteLength('Příliš 🧠\n'))
})

test('add, move, resize and remove refresh the inventory; unchanged trees are byte-identical', t => {
  const f = fixture(t)
  const initial = f.cli().stdout
  f.write('memory/semantic/new.md', 'é')
  const added = f.cli()
  assert.equal(added.status, 0, added.stderr)
  assert.notEqual(added.stdout, initial)
  assert.equal(f.cli().stdout, added.stdout)
  renameSync(join(f.dir, 'memory/semantic/new.md'), join(f.dir, 'memory/episodic/moved.md'))
  const moved = f.cli().stdout
  assert.notEqual(moved, added.stdout)
  assert.match(moved, /episodic\/moved.md/)
  assert.doesNotMatch(moved, /semantic\/new.md/)
  f.write('memory/episodic/moved.md', 'larger 🧠')
  assert.notEqual(f.cli().stdout, moved)
  rmSync(join(f.dir, 'memory/episodic/moved.md'))
  assert.equal(f.cli().stdout, initial)
})

test('creation order and special filename characters do not affect deterministic JSON', t => {
  const a = fixture(t)
  const b = fixture(t)
  const paths = ['semantic/z.md', 'semantic/a/b.md', 'semantic/a.md', 'semantic/🧠 | ` &\n.md']
  for (const path of paths) a.write(`memory/${path}`, path)
  for (const path of [...paths].reverse()) b.write(`memory/${path}`, path)
  assert.equal(renderInventory(a.dir), renderInventory(b.dir))
  assert.equal(JSON.parse(renderInventory(a.dir).split('```json\n')[1].split('\n```')[0]).totalFiles, 4)
})

test('missing and empty tiers are distinct and missing directories are not created', t => {
  const f = fixture(t)
  rmSync(join(f.dir, 'memory/semantic'), { recursive: true })
  const result = tierInventory(f.dir)
  assert.equal(result.tiers[1].status, 'missing')
  assert.equal(result.tiers[0].status, 'empty')
  assert.equal(result.totalFiles, 0)
  assert.equal(result.totalBytes, 0)
  assert.throws(() => readFileSync(join(f.dir, 'memory/semantic')), /ENOENT/)
  rmSync(join(f.dir, 'memory'), { recursive: true })
  blocked(f.cli(), /ENOENT/)
})

test('missing brain, non-directory tiers and invalid UTF-8 fail closed', t => {
  const f = fixture(t)
  assert.throws(() => renderInventory(join(f.dir, 'absent')), /ENOENT/)
  rmSync(join(f.dir, 'memory/core'), { recursive: true })
  f.write('memory/core', 'not a directory')
  blocked(f.cli(), /unsafe inventory directory/)
  rmSync(join(f.dir, 'memory/core'))
  mkdirSync(join(f.dir, 'memory/core'))
  f.write('memory/semantic/broken.md', Buffer.from([0xff]))
  blocked(f.cli(), /encoded data|encoding/i)
})

for (const path of ['memory', 'memory/core', 'memory/core/nested', 'memory/core/link.md', 'memory/core/link.txt']) {
  test(`rejects symlink at ${path} without traversing outside the brain`, t => {
    const f = fixture(t)
    const outside = fixture(t)
    outside.write('secret.md', 'outside content')
    rmSync(join(f.dir, path), { recursive: true, force: true })
    symlinkSync(outside.dir, join(f.dir, path))
    blocked(f.cli(), /symlink|unsafe inventory directory/)
  })
}

test('dangling and internal file links fail instead of being mistaken for missing files', t => {
  const f = fixture(t)
  const link = join(f.dir, 'memory/core/link.md')
  symlinkSync(join(f.dir, 'absent'), link)
  blocked(f.cli(), /symlink/)
  rmSync(link)
  f.write('memory/core/real.md', 'real')
  symlinkSync('real.md', link)
  blocked(f.cli(), /symlink/)
})

test('a special file fails without hanging or publishing a partial inventory', t => {
  const f = fixture(t)
  const fifo = spawnSync('mkfifo', [join(f.dir, 'memory/core/pipe.md')], { encoding: 'utf8' })
  assert.ifError(fifo.error)
  assert.equal(fifo.status, 0, fifo.stderr)
  blocked(f.cli(), /unsupported tier inventory entry: core\/pipe.md/)
})

for (const kind of ['directory', 'file']) {
  test(`unreadable ${kind} is an error, not an empty tier`, t => {
    if (process.getuid?.() === 0) return t.skip('root bypasses permission bits')
    const f = fixture(t)
    f.write('memory/core/secret.md', 'secret')
    const path = join(f.dir, kind === 'directory' ? 'memory/core' : 'memory/core/secret.md')
    chmodSync(path, 0)
    try { blocked(f.cli(), /EACCES|EPERM/) } finally { chmodSync(path, kind === 'directory' ? 0o700 : 0o600) }
  })
}

test('--check verifies standalone output and report sections, rejects stale/absent/duplicate inventories', t => {
  const f = fixture(t)
  const report = join(f.dir, 'report.md')
  const generated = renderInventory(f.dir)
  f.write('report.md', generated)
  assert.equal(f.cli('--check', report).status, 0)
  f.write('report.md', `# Consolidation\n\n${coverage}\n${generated}\n## Next section\nOther evidence\n`)
  assert.equal(f.cli('--check', report).status, 0)
  f.write('memory/procedural/new.md', 'new')
  blocked(f.cli('--check', report), /differs from current tier tree/)
  assert.throws(() => verifyInventory(f.dir, coverage), /exactly one/)
  assert.throws(() => verifyInventory(f.dir, generated + generated), /exactly one/)
  blocked(f.cli('--check', join(f.dir, 'absent.md')), /ENOENT/)
  blocked(f.cli('--wrong'), /usage:/)
  blocked(f.cli('--check'), /usage:/)
})

test('report inventory is committed by the existing checkpoint and leaves Tier Coverage idle detection intact', t => {
  const f = fixture(t)
  f.write('memory/core/rule.md', 'rule\n')
  // The progress ledger must be removed before the final snapshot is generated.
  f.write('memory/episodic/consolidation-progress-2026-11-15.md', 'in progress')
  const draft = renderInventory(f.dir)
  rmSync(join(f.dir, 'memory/episodic/consolidation-progress-2026-11-15.md'))
  assert.throws(() => verifyInventory(f.dir, draft), /differs/)
  const report = `# Consolidation\n\n${coverage}\n${renderInventory(f.dir)}`
  verifyInventory(f.dir, report)
  const path = 'reports/2026-11-15-memory-consolidation.md'
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { cwd: f.dir, env, input, encoding: 'utf8' })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  run('git', ['init', '-q'])
  run('git', ['add', 'memory'])
  run('git', ['commit', '-qm', 'initial'])
  f.write(path, report)
  f.write('reports/2026-11-15-memory-consolidation.json', '{"operationType":"consolidation"}\n')
  run('bash', [join(repo, 'scripts/consolidation-commit.sh'), '.', '2026-11-15', 'steps 10-12'])
  assert.equal(run('git', ['show', `HEAD:${path}`]), report)
  verifyInventory(f.dir, run('git', ['show', `HEAD:${path}`]))
  // Use the same section extraction and shared idle predicate as both guards.
  const idle = spawnSync('bash', ['-c', 'source "$1"; section=$(awk \'/^## Tier Coverage/{flag=1; print; next} /^## /{if(flag) exit} flag\'); tier_coverage_promoted "$section"',
    'inventory-test', join(repo, 'scripts/lib/tier-coverage.sh')], { input: report, encoding: 'utf8', env })
  assert.equal(idle.status, 1, idle.stdout + idle.stderr)
  assert.equal(idle.stderr, '')
})
