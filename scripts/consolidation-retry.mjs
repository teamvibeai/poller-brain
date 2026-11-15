#!/usr/bin/env node
// Read-only, per-target advice inside an already-authorized consolidation.
// The completion/repair and whole-run guards remain authoritative.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const POLICY_VERSION = 'reduction-retry-v1'
export const WEEK_MS = 168 * 60 * 60 * 1000
export const CAPS = { 'CLAUDE.md': 10000, 'memory/SUMMARY.md': 9000 }
const configRoot = fileURLToPath(new URL('../', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const isoTime = value => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

// Only the first generated line is normalized; malformed/duplicate timestamps
// cannot authorize backoff. No whitespace, prose, or byte-size normalization.
export function normalizeSummary(bytes) {
  const text = bytes.toString('utf8')
  const timestamp = /^\*\*Last consolidated:\*\* (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC\r?\n/.exec(text)
  if (!Buffer.from(text).equals(bytes) ||
      !timestamp || !isoTime(`${timestamp[1]}T${timestamp[2]}:00.000Z`) ||
      (text.match(/Last consolidated/g) || []).length !== 1) {
    throw new Error('SUMMARY timestamp normalization uncertain')
  }
  return Buffer.from(text.slice(text.indexOf('\n') + 1))
}

export function fingerprint(root, target, { coverageConfirmed = false, dependencies = [], policyRoot = configRoot } = {}) {
  if (!Object.hasOwn(CAPS, target)) throw new Error('unsupported target')
  if (!coverageConfirmed) throw new Error('dependency coverage unconfirmed')
  const inputs = []
  function collect(path, label) {
    let stat
    try { stat = lstatSync(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      inputs.push([label, 'missing'])
      return
    }
    // Symlinks/special files can escape the inventory or change behind it.
    if (stat.isSymbolicLink()) throw new Error('dependency symlink requires normal search')
    if (stat.isDirectory()) {
      inputs.push([label, 'directory'])
      for (const name of readdirSync(path).sort()) {
        if (label === 'memory' && ['TODAY.md', '.last_consolidation'].includes(name)) continue
        // Generated in-progress bookkeeping is never a relocation source.
        if (label === 'memory/episodic' && /^consolidation-progress-\d{4}-\d\d-\d\d\.md$/.test(name)) continue
        collect(resolve(path, name), `${label}/${name}`)
      }
    } else if (stat.isFile()) {
      let bytes = readFileSync(path)
      if (label === 'memory/SUMMARY.md') bytes = normalizeSummary(bytes)
      inputs.push([label, hash(bytes)])
    } else throw new Error('unsupported dependency type')
  }
  // Broad inventory deliberately invalidates on new sources, even unrelated
  // ones. Include root registry/index files as well as every source tier.
  // TODAY, the publication marker and progress ledgers are not sources.
  for (const path of ['CLAUDE.md', 'memory']) collect(resolve(root, path), path)
  for (const path of [...new Set(dependencies.map(p => resolve(root, p)))].sort()) {
    collect(path, `extra:${relative(root, path)}`)
  }
  for (const path of ['CLAUDE.md', 'MAINTENANCE.md', 'skills/memory/SKILL.md', 'skills/memory/consolidate/SKILL.md',
    'scripts/consolidation-retry.mjs']) {
    const full = resolve(policyRoot, path)
    // A partial/unavailable policy installation must never reuse old advice.
    if (!lstatSync(full).isFile()) throw new Error('policy unavailable')
    inputs.push([`policy:${path}`, hash(readFileSync(full))])
  }
  return hash(JSON.stringify([POLICY_VERSION, target, CAPS[target], inputs]))
}

export function parseRetryBlock(markdown) {
  const blocks = [...markdown.matchAll(/^```consolidation-retry-v1\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)]
  if (blocks.length !== 1 || (markdown.match(/^```consolidation-retry[^\n]*$/gm) || []).length !== 1) {
    throw new Error('missing, duplicate, or incompatible retry block')
  }
  const block = JSON.parse(blocks[0][1])
  if (block.version !== 1 || !block.targets || typeof block.targets !== 'object' || Array.isArray(block.targets)) {
    throw new Error('incompatible retry block')
  }
  return block.targets
}

export function decide(entry, { now, inputFingerprint, reviewRequested = false }) {
  const search = reason => ({ decision: 'search', reason })
  if (reviewRequested) return search('explicit human review requested')
  if (!entry || !['structurally-stalled', 'deferred'].includes(entry.status) ||
      entry.reason !== 'protected-or-pointer-only' || entry.policyVersion !== POLICY_VERSION ||
      typeof entry.reviewReason !== 'string' || !entry.reviewReason.trim() ||
      !isoTime(entry.lastAttemptAt) || !isoTime(entry.nextEligibleAt) ||
      !/^[a-f0-9]{64}$/.test(entry.inputFingerprint || '') || !Number.isFinite(now) ||
      Date.parse(entry.lastAttemptAt) > now ||
      Date.parse(entry.nextEligibleAt) - Date.parse(entry.lastAttemptAt) !== WEEK_MS) {
    return search('missing, incompatible, or invalid structural-stall metadata')
  }
  if (entry.inputFingerprint !== inputFingerprint) return search('decision inputs changed')
  if (now >= Date.parse(entry.nextEligibleAt)) return search('168-hour deadline reached')
  // Copy exactly: repeated deferrals cannot advance either timestamp.
  return { decision: 'deferred', reason: 'structural stall', entry: { ...entry, status: 'deferred' } }
}

// Read from the pre-Step-0 HEAD, never the active cycle's checkpoints/drafts.
// Verify the newest final only; never resurrect a stall from an older report.
export function completedReport(root, completedAt) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
  if (!/^[a-f0-9]{40,64}$/.test(completedAt || '')) throw new Error('pre-Step-0 HEAD required')
  git('merge-base', '--is-ancestor', completedAt, 'HEAD')
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('shallow completion history')
  const history = git('log', '--first-parent', '--format=%H %s', completedAt).split('\n')
  const finalIndex = history.findIndex(line => /^[a-f0-9]+ chore: consolidate memory \(\d{4}-\d\d-\d\d\)$/.test(line))
  if (finalIndex < 0) throw new Error('no completed report')
  if (history.slice(0, finalIndex).some(line => /^[a-f0-9]+ chore: consolidate memory checkpoint \(/.test(line))) {
    throw new Error('unfinished checkpoint at pre-Step-0 HEAD; inspect/repair required')
  }
  const final = history[finalIndex].split(' ')[0]
  // A second-parent completion may be newer than the first-parent final.
  // Do not silently resurrect its older retry state after a merge.
  if (git('rev-list', '--merges', `${final}..${completedAt}`)) throw new Error('merged completion history requires search')
  const date = history[finalIndex].match(/\((\d{4}-\d\d-\d\d)\)$/)[1]
  const path = `reports/${date}-memory-consolidation`
  const paired = sha => {
    try { git('cat-file', '-e', `${sha}:${path}.json`); git('cat-file', '-e', `${sha}:${path}.md`); return true } catch { return false }
  }
  let evidence = final
  if (!paired(final)) {
    const checkpoint = history.slice(finalIndex + 1).find(line =>
      /^[a-f0-9]+ chore: consolidate memory(?: checkpoint)? \(/.test(line))
    if (!checkpoint || checkpoint.slice(checkpoint.indexOf(' ') + 1) !==
        `chore: consolidate memory checkpoint (${date}) — steps 10-12` || !paired(checkpoint.split(' ')[0])) {
      throw new Error('completed report pair unavailable')
    }
    evidence = checkpoint.split(' ')[0]
    // JSON consumption may change the tree; markdown must still match 12a.
    if (git('rev-parse', `${final}:${path}.md`) !== git('rev-parse', `${evidence}:${path}.md`)) {
      throw new Error('final markdown differs from report checkpoint')
    }
  }
  return { final, evidence, path: `${path}.md`, markdown: git('show', `${final}:${path}.md`) }
}

export function advise(root, target, options) {
  if (!Object.hasOwn(CAPS, target)) throw new Error('unsupported target')
  const result = { target, policyVersion: POLICY_VERSION, inputFingerprint: null, decision: 'search' }
  try {
    result.inputFingerprint = fingerprint(root, target, options)
    const source = completedReport(root, options.completedAt)
    result.source = { final: source.final, evidence: source.evidence, path: source.path }
    Object.assign(result, decide(parseRetryBlock(source.markdown)[target], { ...options, inputFingerprint: result.inputFingerprint }))
  } catch (error) { result.reason = error.message }
  return result
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, target, ...args] = process.argv.slice(2)
    const options = { now: Date.now(), dependencies: [] }
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--completed-at' && args[i + 1]) options.completedAt = args[++i]
      else if (args[i] === '--dependency' && args[i + 1]) options.dependencies.push(args[++i])
      else if (args[i] === '--coverage-confirmed') options.coverageConfirmed = true
      else if (args[i] === '--review') options.reviewRequested = true
      else throw new Error('unknown or incomplete option')
    }
    if (!root) throw new Error('usage: consolidation-retry.mjs BRAIN_DIR TARGET --completed-at START_HEAD [--coverage-confirmed] [--dependency PATH] [--review]')
    console.log(JSON.stringify(advise(resolve(root), target, options), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
