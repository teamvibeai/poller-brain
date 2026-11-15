#!/usr/bin/env node
// Read-only history invariant. No staging, marker changes, backfill or repair.
// Usage: node consolidation-history.mjs BRAIN_DIR YYYY-MM-DD [--report|--final]
//        node consolidation-history.mjs BRAIN_DIR YYYY-MM-DD --committed FINAL REPORT_COMMIT [START_HEAD]
import { readFileSync, lstatSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const [brain, date, mode, final, evidence, markerHead] = process.argv.slice(2)
const cwd = resolve(brain || '.')
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const scriptDir = dirname(fileURLToPath(import.meta.url))
let start = markerHead || '(marker unavailable)'
const path = `memory/episodic/archive/consolidation-history-${date?.slice(0, 4)}-H${Number(date?.slice(5, 7)) <= 6 ? 1 : 2}.md`
function fail(message) { throw new Error(message) }
function git(...args) {
  const result = spawnSync('git', args, { cwd, env })
  if (result.status !== 0) fail(`cannot read git evidence: ${args.join(' ')}`)
  return result.stdout
}
function text(...args) { return git(...args).toString('utf8').trim() }
function blob(revision, name, optional = false) {
  const entry = text('ls-tree', revision, '--', name)
  if (!entry && optional) return Buffer.alloc(0)
  if (!/^100(644|755) blob /.test(entry)) fail(`missing/unreadable regular file ${revision}:${name}`)
  return git('show', `${revision}:${name}`)
}
function disk(name) {
  for (let dir = name; dir !== '.'; dir = dirname(dir)) {
    if (lstatSync(join(cwd, dir)).isSymbolicLink()) fail(`symlink evidence: ${name}`)
  }
  if (!lstatSync(join(cwd, name)).isFile()) fail(`not a regular file: ${name}`)
  return readFileSync(join(cwd, name))
}
const reportPath = `reports/${date}-memory-consolidation.json`
function metadata(bytes, legacy = false) {
  const report = JSON.parse(bytes.toString('utf8'))
  if (!Object.hasOwn(report, 'consolidationHistory') && legacy) return null
  const meta = report.consolidationHistory
  if (report.operationType !== 'consolidation' || meta?.version !== 1 || meta.cycleDate !== date ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(meta.startingHead) ||
      (start !== '(marker unavailable)' && meta.startingHead !== start)) {
    fail('missing/invalid consolidationHistory v1 report metadata or conflicting cycle identity')
  }
  return meta
}
function validate(bytes, revision) {
  git('merge-base', '--is-ancestor', start, revision)
  const before = blob(start, path, true)
  if (!bytes.subarray(0, before.length).equals(before)) fail('existing archive bytes were not preserved')
  const suffix = bytes.subarray(before.length).toString('utf8')
  // Exactly one bounded record in the new append: prose mentions, empty
  // headings and another same-day cycle cannot stand in for this identity.
  const heading = `## Consolidation ${date} / ${start}`
  const record = suffix.match(/^\s*(## Consolidation [^\n]+)\nStatus: in progress\nWork performed: ([^\n]+)\n<!-- \/consolidation-history -->\n?\s*$/)
  if (!record || record[1] !== heading || record[2].trim().length < 20 || record[2].trim().split(/\s+/).length < 3) {
    fail('missing substantive in-progress record for this exact cycle in the new append')
  }
  if (before.toString('utf8').split('\n').includes(heading)) fail('cycle record already existed at starting HEAD')
}

try {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('invalid cycle date')
  if (mode === '--committed') {
    const meta = metadata(blob(evidence, reportPath), true)
    if (!meta) {
      console.log('consolidation_history: legacy report (history requirement not versioned)')
      process.exit(0)
    }
    start = meta.startingHead
    validate(blob(final, path), final)
  } else {
    if (mode && !['--report', '--final'].includes(mode)) fail('invalid validator mode')
    const marker = spawnSync('bash', [join(scriptDir, 'consolidation-marker.sh'), 'inspect', cwd], { env, encoding: 'utf8' })
    if (marker.status !== 1) fail(`valid durable marker required: ${marker.stdout.trim()}`)
    const [, cycleDate, startingHead] = marker.stdout.trim().split(' ')
    start = startingHead
    if (cycleDate !== date) fail(`date conflicts with original UTC marker date ${cycleDate}`)
    validate(disk(path), 'HEAD')
    if (mode === '--report') metadata(disk(reportPath))
    if (mode === '--final') {
      // The final helper excludes JSON changes. Validate the JSON that will be
      // committed, falling back only to the exact Step 12a checkpoint if consumed.
      let reportCommit = 'HEAD'
      const pair = revision => ['md', 'json'].every(ext => text('ls-tree', revision, '--', `reports/${date}-memory-consolidation.${ext}`))
      if (!pair(reportCommit)) {
        const subject = `chore: consolidate memory checkpoint (${date}) — steps 10-12`
        reportCommit = text('log', '--format=%H %s', `${start}..HEAD`).split('\n')
          .find(line => line.slice(line.indexOf(' ') + 1) === subject)?.split(' ')[0]
        if (!reportCommit || !pair(reportCommit)) fail('committed final/Step 12a report pair unavailable')
      }
      git('merge-base', '--is-ancestor', start, reportCommit)
      metadata(blob(reportCommit, reportPath))
    }
  }
  console.log(`consolidation_history: valid (${path}; ${date} / ${start})`)
} catch (error) {
  console.error(`consolidation_history: blocked (${path}; ${date} / ${start}; ${error.message})`)
  process.exitCode = 1
}
