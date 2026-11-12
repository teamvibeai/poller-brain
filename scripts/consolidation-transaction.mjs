// Shared strict memory transaction for consolidation-apply/commit.sh. No recovery:
// a killed process leaves the lifecycle lock and marker for explicit inspection.
import { readFileSync, writeFileSync, lstatSync, mkdirSync, rmdirSync, unlinkSync, renameSync, copyFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [action, brain, date, boundary, ...args] = process.argv.slice(2)
const prefix = `consolidation_${action === 'apply' ? 'apply' : 'commit'}`
const fail = message => { throw new Error(message) }
const same = (a, b) => a === null ? b === null : b !== null && a.equals(b)
const sha = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const stat = path => { try { return lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
let root, env, lock, indexLock, scratch
function git(args, options = {}) {
  const result = spawnSync('git', ['--literal-pathspecs', ...args], { cwd: root, env, maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) fail(`git ${args[0]} failed: ${result.error?.message || result.stderr?.toString().trim()}`)
  return result.stdout
}
const gitText = args => git(args).toString().trim()
function safePath(path) {
  if (typeof path !== 'string' || !/^memory\/(?:[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\/)*[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.md$/u.test(path) ||
      path.split('/').some(part => part === '.' || part === '..' || part.endsWith(' '))) fail(`unsafe memory path: ${path}`)
  let current = root
  for (const [i, part] of path.split('/').entries()) {
    current = join(current, part)
    const info = stat(current)
    if (!info) continue
    if (info.isSymbolicLink() || (i < path.split('/').length - 1 ? !info.isDirectory() : !info.isFile())) fail(`unsafe memory path component: ${path}`)
  }
}
function disk(path) { return stat(join(root, path)) ? readFileSync(join(root, path)) : null }
function committed(path, ref = 'HEAD') {
  const entry = gitText(['ls-tree', ref, '--', path])
  if (!entry) return null
  if (!entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob ')) fail(`unsafe baseline entry: ${path}`)
  return git(['show', `${ref}:${path}`])
}
function cleanIndex(paths) {
  if (git(['ls-files', '--unmerged', '-z']).length) fail('unmerged index')
  if (paths.length && git(['diff', '--cached', '--name-only', '-z', 'HEAD', '--', ...paths]).length) fail('baseline conflict in staged memory paths')
}
function checkDiff() {
  git(['diff', '--cached', '--check'])
}
function commitMemory(paths, head) {
  cleanIndex(paths)
  const changed = paths.filter(path => !same(disk(path), committed(path)))
  if (!changed.length) return
  // Hold the real index lock throughout. Git and hooks use a private index;
  // failure cannot stage outputs or consume unrelated partially staged work.
  const index = resolve(root, gitText(['rev-parse', '--git-path', 'index']))
  writeFileSync(`${index}.lock`, '', { flag: 'wx' })
  indexLock = `${index}.lock`
  scratch = mkdtempSync(join(dirname(index), 'consolidation-index-'))
  const originalEnv = env
  const privateIndex = join(scratch, 'index')
  const nextIndex = join(scratch, 'next')
  let published
  let commitAttempted = false
  try {
    cleanIndex(paths)
    copyFileSync(index, nextIndex)
    env = { ...env, GIT_INDEX_FILE: privateIndex }
    git(['read-tree', head])
    git(['add', '-A', '--', ...changed])
    checkDiff()
    const tree = gitText(['write-tree'])
    for (const path of changed) {
      if (!same(committed(path, tree), disk(path))) fail(`staged content differs from requested bytes: ${path}`)
    }
    // Prepare the post-commit index before publishing any commit.
    env = { ...env, GIT_INDEX_FILE: nextIndex }
    const records = git(['ls-files', '--stage', '-z', '--', ...changed], { env: { ...env, GIT_INDEX_FILE: privateIndex } })
    const removals = Buffer.from(changed.map(path => `0 ${'0'.repeat(head.length)}\t${path}\0`).join(''))
    git(['update-index', '-z', '--index-info'], { input: Buffer.concat([removals, records]) })
    env = { ...env, GIT_INDEX_FILE: privateIndex }
    const subject = `chore: consolidate memory checkpoint (${date}) — ${boundary}`
    if (gitText(['rev-parse', 'HEAD']) !== head) fail('baseline HEAD conflict before commit')
    commitAttempted = true
    git(['commit', '-m', subject])
    const resultHead = published = gitText(['rev-parse', 'HEAD'])
    if (gitText(['rev-parse', 'HEAD^{tree}']) !== tree || gitText(['rev-parse', 'HEAD^']) !== head || gitText(['log', '-1', '--format=%s']) !== subject) {
      fail('commit changed the planned tree, ancestry or subject')
    }
    // Publishing a prepared index requires no further Git operation.
    renameSync(nextIndex, indexLock)
    renameSync(indexLock, index)
    indexLock = undefined
    process.stdout.write(`${prefix}: checkpoint ${resultHead}\n`)
  } catch (error) {
    // A commit command can report failure after updating the ref. Inspect it
    // while holding the index/lifecycle locks before rolling back this request.
    if (commitAttempted && !published) published = gitText(['rev-parse', 'HEAD'])
    if (published && published !== head) git(['update-ref', 'HEAD', head, published])
    throw error
  } finally { env = originalEnv }
}

try {
  if (!['apply', 'commit'].includes(action) || !brain || !validDate(date) || !boundary) fail('invalid arguments or cycle date')
  if (process.env.GIT_INDEX_FILE || process.env.GIT_DIR || process.env.GIT_WORK_TREE) fail('Git directory/index overrides are not supported')
  root = realpathSync(brain)
  env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  if (gitText(['rev-parse', '--show-toplevel']) !== root) fail('brain directory must be the repository root')
  const marker = resolve(root, gitText(['rev-parse', '--git-path', 'consolidation-start']))
  mkdirSync(`${marker}.lock`)
  lock = `${marker}.lock`
  const inspected = spawnSync('bash', [fileURLToPath(new URL('consolidation-marker.sh', import.meta.url)), 'inspect', root], { env, encoding: 'utf8' })
  if (inspected.status !== 1) fail(`invalid start marker: ${inspected.stdout || inspected.stderr}`)
  const [, markerDate, start] = inspected.stdout.trim().split(' ')
  if (markerDate !== date) fail('cycle date conflicts with start marker')
  git(['merge-base', '--is-ancestor', start, 'HEAD'])
  const head = gitText(['rev-parse', 'HEAD'])
  if (action === 'commit') {
    if (!args.length || boundary === 'final') fail('memory-only mode requires exact paths and a checkpoint boundary')
    for (const path of args) safePath(path)
    commitMemory([...new Set(args)], head)
  } else {
    if (!/^step (?:1[b-c]?|2|3|4|5[b-d]?|7)$/.test(boundary) || args.length > 1) fail('unsupported mutation step')
    const plan = JSON.parse(readFileSync(args[0] && args[0] !== '-' ? args[0] : 0, 'utf8'))
    if (plan.version !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(plan.baseline) || !Array.isArray(plan.mutations)) fail('invalid mutation manifest')
    if (!plan.validation || !Array.isArray(plan.validation.alarms) || plan.validation.alarms.length) fail('missing validation or unresolved validation alarms')
    git(['merge-base', '--is-ancestor', plan.baseline, head])
    if (plan.baseline !== start) git(['merge-base', '--is-ancestor', start, plan.baseline])
    const paths = new Set()
    const changes = plan.mutations.map(m => {
      safePath(m.path)
      if (paths.has(m.path)) fail(`duplicate mutation path: ${m.path}`)
      paths.add(m.path)
      if (!['write', 'delete'].includes(m.op) || (m.op === 'write' && typeof m.content !== 'string') ||
          !(m.before === null || (typeof m.before === 'string' && /^[a-f0-9]{64}$/.test(m.before)))) fail('invalid mutation operation/content/before hash')
      if (boundary === 'step 7') {
        const match = /^memory\/daily\/(?:weekly-)?(\d{4}-\d{2}-\d{2})\.md$/.exec(m.path)
        const today = new Date().toISOString().slice(0, 10)
        if (m.op !== 'delete' || !match || !validDate(match[1]) || Date.parse(date) - Date.parse(match[1]) <= 30 * 86400000 || Date.parse(today) - Date.parse(match[1]) <= 30 * 86400000) fail('unsafe step 7 retention mutation')
      } else {
        if (!/^memory\/(?:TODAY\.md|MEM_REGISTRY(?:_ARCHIVE)?\.md|(?:core|semantic|episodic|procedural|daily)\/.+\.md)$/.test(m.path)) fail('path is not a Steps 1–5d output')
        if (m.op === 'delete' && m.path.startsWith('memory/daily/')) fail('daily log deletions require step 7 retention validation')
      }
      const before = disk(m.path)
      const desired = m.op === 'delete' ? null : Buffer.from(m.content)
      if (sha(committed(m.path, plan.baseline)) !== m.before) fail(`baseline content conflict: ${m.path}`)
      return { path: m.path, before, desired, expected: m.before, mode: stat(join(root, m.path))?.mode }
    })
    cleanIndex([...paths])
    // A stale manifest is accepted only as a fully committed, unchanged retry.
    const retry = changes.every(c => same(c.before, c.desired) && same(committed(c.path), c.desired))
    if (!retry) {
      if (head !== plan.baseline) fail('baseline HEAD conflict')
      for (const c of changes) {
        if (sha(c.before) !== c.expected || !same(c.before, committed(c.path))) fail(`baseline content conflict: ${c.path}`)
      }
      const created = []
      try {
        for (const c of changes) {
          if (same(c.before, c.desired)) continue
          if (c.desired === null) unlinkSync(join(root, c.path))
          else {
            const missing = []
            for (let dir = dirname(join(root, c.path)); !stat(dir); dir = dirname(dir)) missing.unshift(dir)
            for (const dir of missing) { mkdirSync(dir); created.push(dir) }
            writeFileSync(join(root, c.path), c.desired, { mode: c.mode ?? 0o644 })
          }
        }
        commitMemory([...paths], head)
      } catch (error) {
        // Synchronous failure restores only this request; interrupted processes
        // retain marker/lock evidence and require manual inspection (#606).
        for (const c of changes) {
          if (c.before === null) { if (stat(join(root, c.path))) unlinkSync(join(root, c.path)) }
          else writeFileSync(join(root, c.path), c.before, { mode: c.mode })
        }
        for (const dir of created.reverse()) rmdirSync(dir)
        throw error
      }
    }
    process.stdout.write(`${prefix}: verified ${changes.length} mutation(s)\n`)
  }
} catch (error) {
  process.stderr.write(`${prefix}: ${error.message}; stop and inspect, no automatic recovery\n`)
  process.exitCode = 2
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  if (indexLock) { try { unlinkSync(indexLock) } catch {} }
  if (lock) rmdirSync(lock)
}
