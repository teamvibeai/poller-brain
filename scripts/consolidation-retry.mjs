#!/usr/bin/env node
// Read-only, per-target advice inside an already-authorized consolidation.
// The completion/repair and whole-run guards remain authoritative.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { historyPathFor, validateHistoryAppend } from './consolidation-history-schema.mjs'

export const POLICY_VERSION = 'reduction-retry-v1'
export const WEEK_MS = 168 * 60 * 60 * 1000
export const CAPS = { 'CLAUDE.md': 10000, 'memory/SUMMARY.md': 9000 }
const configRoot = fileURLToPath(new URL('../', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const isoTime = value => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const historyPath = /^memory\/episodic\/archive\/consolidation-history-\d{4}-H[12]\.md$/
const historyEnd = '<!-- /consolidation-history -->'
const gitBytes = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
})
const gitText = (root, ...args) => gitBytes(root, ...args).toString('utf8').trimEnd()

function historyBlob(root, revision, path) {
  const entry = gitText(root, 'ls-tree', revision, '--', path)
  if (!entry) return null
  if (!/^100(644|755) blob /.test(entry)) throw new Error('history is not a regular Git blob')
  return gitBytes(root, 'show', `${revision}:${path}`)
}

// Peel only the shared schema's exact appends, anchored in their starting Git
// trees. Legacy prefix bytes remain sources. Once committed, an append must
// still equal its FIRST committed bytes: otherwise a schema-valid rewrite of
// old Work performed text would disappear along with routine bookkeeping.
function normalizeHistory(root, path, bytes, head) {
  const committed = historyBlob(root, head, path)
  if (committed && !bytes.subarray(0, committed.length).equals(committed)) {
    throw new Error('history normalization uncertain: committed prefix changed')
  }
  let revision = head
  while (true) {
    const text = bytes.toString('utf8')
    if (!Buffer.from(text).equals(bytes)) throw new Error('history normalization uncertain: invalid UTF-8')
    const record = /## Consolidation (\d{4}-\d\d-\d\d) \/ ([a-f0-9]{40}|[a-f0-9]{64})\nStatus: in progress\nWork performed: [^\n]+\n<!-- \/consolidation-history -->\n?\s*$/.exec(text)
    if (!record) {
      if (text.includes(historyEnd) || /^## Consolidation .*\//m.test(text) ||
          gitText(root, 'log', '--first-parent', '--format=%H', '-S', historyEnd, revision, '--', path)) {
        throw new Error('history normalization uncertain: malformed or removed records')
      }
      return bytes
    }
    const [, date, start] = record
    if (historyPathFor(date) !== path) throw new Error('history normalization uncertain: wrong date bucket')
    gitText(root, 'merge-base', '--is-ancestor', start, revision)
    if (gitText(root, 'rev-list', '--merges', `${start}..${revision}`)) {
      throw new Error('history normalization uncertain: merged append history')
    }
    const before = historyBlob(root, start, path)
    validateHistoryAppend(before || Buffer.alloc(0), bytes, date, start)
    const changes = gitText(root, 'log', '--first-parent', '--reverse', '--format=%H', `${start}..${revision}`, '--', path).split('\n').filter(Boolean)
    if (changes.length) {
      for (const change of changes) {
        const original = historyBlob(root, change, path)
        if (!original || !original.equals(bytes)) throw new Error('history normalization uncertain: original append changed')
      }
    } else {
      // An uncommitted first append needs the actual durable cycle identity.
      const marker = spawnSync('bash', [fileURLToPath(new URL('./consolidation-marker.sh', import.meta.url)), 'inspect', root], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8',
      })
      const [, cycleDate, startingHead] = marker.stdout?.trimEnd().split(' ') || []
      if (marker.status !== 1 || cycleDate !== date || startingHead !== start) {
        throw new Error('history normalization uncertain: unverified active cycle')
      }
    }
    if (before === null) return null
    bytes = before
    revision = start
  }
}

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

// Exact allowlist for plain, date-headed daily bullet logs. A suffix, MEM tag,
// unknown maintenance message, malformed time, or unfinished line is source
// content, never bookkeeping. Multi-line/Markdown contexts are uncertain and
// must search rather than risk filtering a quoted/example/continued entry.
// Return null only for sections containing verified maintenance and nothing
// else; their date headers, blank scaffolding and file availability add no input.
export function normalizeDaily(bytes, date) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) throw new Error('daily normalization uncertain: invalid UTF-8')
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || []
  const clock = '(?:[01][0-9]|2[0-3]):[0-5][0-9]'
  const maintenance = new RegExp(`^- (?:${clock} — |\\[${clock}\\] )(?:memory consolidation (?:started|completed)|maintenance: consolidation session)\\r?\\n$`)
  if (!lines.some(line => maintenance.test(line))) return bytes
  if (!isoTime(`${date}T00:00:00.000Z`) || /[`<>]|~{3}|\u0000|\r(?!\n)/.test(text)) {
    throw new Error('daily normalization uncertain: date or Markdown context')
  }
  const sections = []
  let section
  let prefix = ''
  for (const [index, line] of lines.entries()) {
    if (line === `# ${date}\n` || line === `# ${date}\r\n`) {
      // Step 0/log rollover appends "\n# DATE\n". That one separator belongs
      // to the new section, not to the preceding substantive entry.
      if (section && /^\r?\n$/.test(lines[index - 1])) prefix = section.kept.pop()
      section = { kept: [prefix, line], maintenance: false, source: false }
      prefix = ''
      sections.push(section)
    } else if (/^\r?\n$/.test(line)) {
      if (section) section.kept.push(line)
      else prefix += line
    } else {
      if (!section || !line.startsWith('- ')) {
        throw new Error('daily normalization uncertain: expected date-headed single-line bullets')
      }
      if (maintenance.test(line)) section.maintenance = true
      else { section.source = true; section.kept.push(line) }
    }
  }
  // Preserve all bytes of source-bearing sections except allowlisted lines.
  // Header-only/empty sections remain inputs; only proven maintenance vanishes.
  const kept = sections.filter(s => s.source || !s.maintenance).map(s => s.kept.join(''))
  return kept.length ? Buffer.from(kept.join('')) : null
}

export function fingerprint(root, target, { coverageConfirmed = false, dependencies = [], policyRoot = configRoot } = {}) {
  if (!Object.hasOwn(CAPS, target)) throw new Error('unsupported target')
  if (!coverageConfirmed) throw new Error('dependency coverage unconfirmed')
  const head = gitText(root, 'rev-parse', 'HEAD')
  // A removed bookkeeping-only archive must not vanish without verification.
  const historyFiles = new Set(gitText(root, 'log', '--first-parent', '--format=', '--name-only', head,
    '--', 'memory/episodic/archive').split('\n').filter(path => historyPath.test(path)))
  for (const path of historyFiles) {
    try {
      if (!lstatSync(resolve(root, path)).isFile()) throw new Error('history archive missing or unreadable')
    } catch (error) {
      if (error.code !== 'ENOENT' || gitText(root, 'log', '--first-parent', '--format=%H', '-S', historyEnd, head, '--', path)) throw error
    }
  }
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
      const start = inputs.length
      inputs.push([label, 'directory'])
      for (const name of readdirSync(path).sort()) {
        if (label === 'memory' && ['TODAY.md', '.last_consolidation'].includes(name)) continue
        // Generated in-progress bookkeeping is never a relocation source.
        if (label === 'memory/episodic' && /^consolidation-progress-\d{4}-\d\d-\d\d\.md$/.test(name)) continue
        collect(resolve(path, name), `${label}/${name}`)
      }
      // Creating the first bookkeeping-only archive/directories is a no-op.
      if (['memory/daily', 'memory/episodic', 'memory/episodic/archive'].includes(label) && inputs.length === start + 1) inputs.pop()
    } else if (stat.isFile()) {
      let bytes = readFileSync(path)
      if (label === 'memory/SUMMARY.md') bytes = normalizeSummary(bytes)
      const daily = /^memory\/daily\/(\d{4}-\d\d-\d\d)\.md$/.exec(label)
      if (daily) {
        bytes = normalizeDaily(bytes, daily[1])
        if (bytes === null) return
      }
      if (historyPath.test(label)) {
        if (gitText(root, 'rev-parse', '--is-shallow-repository') !== 'false') throw new Error('shallow append history')
        bytes = normalizeHistory(root, label, bytes, head)
        if (bytes === null) return
      }
      inputs.push([label, hash(bytes)])
    } else throw new Error('unsupported dependency type')
  }
  // Broad inventory deliberately invalidates on new sources, even unrelated
  // ones. Include root registry/index files as well as every source tier.
  // TODAY, the publication marker, progress ledgers and verified maintenance-
  // only daily sections and verified history appends are not sources. Legacy
  // history prefixes and all other daily content remain inputs.
  for (const path of ['CLAUDE.md', 'memory']) collect(resolve(root, path), path)
  for (const path of [...new Set(dependencies.map(p => resolve(root, p)))].sort()) {
    collect(path, `extra:${relative(root, path)}`)
  }
  for (const path of ['CLAUDE.md', 'MAINTENANCE.md', 'skills/memory/SKILL.md', 'skills/memory/consolidate/SKILL.md',
    'scripts/consolidation-retry.mjs', 'scripts/consolidation-history-schema.mjs', 'scripts/consolidation-marker.sh']) {
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
