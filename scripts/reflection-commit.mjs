// Scoped reflection checkpoint/final commit. No reflection lifecycle state machine.
// node reflection-commit.mjs BRAIN_DIR YYYY-MM-DD checklist|final MANIFEST.json
// Manifest: { paths: [exact reviewed paths], deletionPreservation: { path: reason } }
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const [brain, date, boundary, manifest, ...extra] = process.argv.slice(2)
const fail = message => { throw new Error(message) }
const stat = path => { try { return lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
let root, env, scratch, lock
function git(args, options = {}) {
  // Hooks can mutate other paths or the index. Keep every Git call isolated.
  const result = spawnSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.autoRefreshIndex=false', ...args],
    { cwd: root, env, maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) fail(`git ${args[0]} failed: ${result.error?.message || result.stderr?.toString().trim()}`)
  return result.stdout
}
const gitText = args => git(args).toString().trim()
function safePath(path, reports) {
  if (typeof path !== 'string' || (!/^memory\/.+\.md$/u.test(path) && !reports.includes(path)) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      /[\x00-\x1f\x7f\\:*?\[\]]/u.test(path)) fail(`not an exact reflection path: ${path}`)
  const parts = path.split('/')
  let current = root
  for (const [i, part] of parts.entries()) {
    current = join(current, part)
    const info = stat(current)
    if (info && (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))) fail(`unsafe reflection path: ${path}`)
  }
}

try {
  if (!brain) fail('brain directory required')
  root = realpathSync(brain)
  // This gate precedes even Git inspection, locks, scratch or manifest reads.
  if (stat(join(root, 'MAINTENANCE_DISABLED'))) fail('maintenance disabled; no writes performed')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date || !['checklist', 'final'].includes(boundary) || !manifest || extra.length) fail('invalid date or arguments')
  if (process.env.GIT_INDEX_FILE || process.env.GIT_DIR || process.env.GIT_WORK_TREE) fail('Git directory/index overrides are not supported')
  env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  if (gitText(['rev-parse', '--show-toplevel']) !== root) fail('brain directory must be the repository root')
  const episodic = `memory/episodic/reflection-${date}.md`
  const reports = [`reports/${date}-memory-reflection.md`, `reports/${date}-memory-reflection.json`]
  const plan = JSON.parse(readFileSync(manifest, 'utf8'))
  if (!Array.isArray(plan.paths) || new Set(plan.paths).size !== plan.paths.length) fail('manifest requires unique reviewed paths')
  const paths = plan.paths
  for (const path of paths) safePath(path, boundary === 'final' ? reports : [])
  if (boundary === 'checklist') {
    if (stat(join(root, episodic)) || paths.includes(episodic)) fail('dated episodic reflection must not exist before finalization')
  } else {
    for (const path of [episodic, ...reports]) {
      if (!paths.includes(path) || !stat(join(root, path))?.isFile()) fail(`final requires reviewed report: ${path}`)
    }
  }
  const head = gitText(['rev-parse', 'HEAD'])
  if (git(['ls-files', '--unmerged', '-z']).length) fail('unmerged index')
  // Overlapping staged work cannot be attributed safely to reflection.
  if (paths.length && git(['diff', '--cached', '--name-only', '-z', head, '--', ...paths]).length) fail('reviewed paths overlap staged work; resolve ownership first')
  const index = resolve(root, gitText(['rev-parse', '--git-path', 'index']))
  writeFileSync(`${index}.lock`, '', { flag: 'wx' })
  lock = `${index}.lock`
  if (paths.length && git(['diff', '--cached', '--name-only', '-z', head, '--', ...paths]).length) fail('reviewed paths overlap staged work; resolve ownership first')
  // Keep replacement indexes on the real index filesystem for atomic rename.
  scratch = mkdtempSync(join(dirname(index), 'reflection-index-'))
  const privateIndex = join(scratch, 'index')
  const nextIndex = join(scratch, 'next')
  copyFileSync(index, nextIndex)
  env.GIT_INDEX_FILE = privateIndex
  git(['read-tree', head])
  // Skip absent, never-tracked reviewed paths; git add would reject those.
  for (const path of paths) {
    if (stat(join(root, path)) || git(['ls-files', '-z', '--', path]).length) git(['add', '-A', '--', path])
  }
  for (const path of paths) safePath(path, boundary === 'final' ? reports : [])
  if (boundary === 'final') {
    const required = [episodic, ...reports]
    const regularReports = new Set(git(['ls-files', '--stage', '-z', '--', ...required]).toString().split('\0')
      .filter(entry => /^100(644|755) [0-9a-f]+ 0\t/.test(entry)).map(entry => entry.slice(entry.indexOf('\t') + 1)))
    for (const path of required) {
      if (!regularReports.has(path)) fail(`final requires staged regular report: ${path}`)
    }
  }
  if (paths.length && git(['diff', '--name-only', '-z', '--', ...paths]).length) fail('reviewed working files changed during staging')
  git(['diff', '--cached', '--check'])
  const fields = git(['diff', '--cached', '--name-status', '--no-renames', '-z', head]).toString().split('\0')
  const changes = []
  for (let i = 0; fields[i]; i += 2) changes.push({ status: fields[i], path: fields[i + 1] })
  const deletionPreservation = {}
  for (const { status, path } of changes) {
    if (status !== 'D') continue
    const reason = plan.deletionPreservation?.[path]
    if (typeof reason !== 'string' || !reason.trim()) fail(`missing deletion preservation evidence: ${path}`)
    deletionPreservation[path] = reason
  }
  const evidence = { date, boundary, baseline: head, filesChanged: changes.map(c => c.path), changes, deletionPreservation }
  if (!changes.length) {
    if (gitText(['rev-parse', 'HEAD']) !== head) fail('HEAD changed during no-change verification')
    // An empty review list means no reviewed changes, never a broad memory sweep.
    evidence.result = 'no-change'
  } else {
    const tree = gitText(['write-tree'])
    // Overlay only reflection entries onto a copy of the real index. Every
    // unrelated staged entry (including partial staging) remains byte-for-byte.
    const changedPaths = changes.map(c => c.path)
    const records = git(['ls-files', '--stage', '-z', '--', ...changedPaths])
    const removals = Buffer.from(changedPaths.map(path => `0 ${'0'.repeat(head.length)}\t${path}\0`).join(''))
    env.GIT_INDEX_FILE = nextIndex
    git(['update-index', '-z', '--index-info'], { input: Buffer.concat([removals, records]) })
    const subject = boundary === 'final' ? `chore: memory reflection (${date})` : `chore: memory reflection checkpoint (${date}) — checklist`
    // Persist cumulative checklist/deletion evidence in Git, without creating a
    // cadence-bearing report or another generated memory artifact.
    const message = `${subject}\n\nReflection-Evidence: ${JSON.stringify(evidence)}\n`
    const commit = gitText(['commit-tree', tree, '-p', head, '--no-gpg-sign', '-m', message])
    // Prepare the index before publishing. CAS rejects a concurrent HEAD change.
    renameSync(nextIndex, lock)
    git(['update-ref', '-m', subject, 'HEAD', commit, head])
    try {
      renameSync(lock, index)
    } catch (error) {
      // Roll back only our own publication; never overwrite concurrent work.
      try {
        git(['update-ref', '-m', 'reflection index publication rollback', 'HEAD', head, commit])
      } catch (rollbackError) {
        const recoveryIndex = lock
        lock = undefined // Retain the prepared index, including unrelated staging.
        fail(`index publication failed after published commit ${commit}: ${error.message}; HEAD rollback failed: ${rollbackError.message}; recovery: prepared index preserved at ${recoveryIndex}; inspect HEAD and reconcile this index before further Git writes`)
      }
      fail(`index publication failed after published commit ${commit}: ${error.message}; HEAD restored to ${head}; recovery: original index retained; inspect the failure before retrying`)
    }
    lock = undefined
    evidence.result = 'committed'
    evidence.commit = commit
  }
  rmSync(scratch, { recursive: true })
  scratch = undefined
  if (lock) { unlinkSync(lock); lock = undefined }
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
} catch (error) {
  process.stderr.write(`reflection_commit: ${error.message}; stop before report production/finalization\n`)
  process.exitCode = 1
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  if (lock) unlinkSync(lock)
}
