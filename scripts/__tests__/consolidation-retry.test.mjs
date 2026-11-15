import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { advise, completedReport, decide, fingerprint, normalizeDaily, parseRetryBlock, POLICY_VERSION, WEEK_MS, CAPS } from '../consolidation-retry.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const summary = 'memory/SUMMARY.md'
const claude = 'CLAUDE.md'
const attempted = Date.parse('2026-11-14T01:00:00.000Z')
const now = attempted + 24 * 3600000
const policyFiles = ['CLAUDE.md', 'MAINTENANCE.md', 'skills/memory/SKILL.md',
  'skills/memory/consolidate/SKILL.md', 'scripts/consolidation-retry.mjs',
  'scripts/consolidation-history-schema.mjs', 'scripts/consolidation-marker.sh']
const block = targets => `## Reduction Retry Cadence\n\n\`\`\`consolidation-retry-v1\n${JSON.stringify({ version: 1, targets })}\n\`\`\`\n`
const cleared = status => ({ status, reason: status, lastAttemptAt: null, nextEligibleAt: null,
  inputFingerprint: null, policyVersion: POLICY_VERSION, reviewReason: null })

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-retry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trimEnd()
  }
  const write = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  write(claude, '# Identity\n@memory/SUMMARY.md\n@memory/TODAY.md\n' + 'protected behavioral rule\n'.repeat(500))
  write(summary, '**Last consolidated:** 2026-11-14 01:00 UTC\n\n## Key Rules\n' + 'unique always-in-context rule\n'.repeat(400))
  write('memory/core/LEARNINGS.md', 'protected lesson\n')
  write('memory/semantic/project.md', 'reference material\n')
  write('reports/.gitkeep', '')
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base')
  const opts = overrides => ({ completedAt: git('rev-parse', 'HEAD'), coverageConfirmed: true, now, ...overrides })
  const stall = target => ({ status: 'structurally-stalled', reason: 'protected-or-pointer-only',
    lastAttemptAt: new Date(attempted).toISOString(), nextEligibleAt: new Date(attempted + WEEK_MS).toISOString(),
    inputFingerprint: fingerprint(dir, target, opts()), policyVersion: POLICY_VERSION,
    reviewReason: 'Entire remainder is protected; needs human review' })
  const report = (targets, { date = '2026-11-14', checkpoint = false, consume = false, finalize = true, markdown = block(targets) } = {}) => {
    const path = `reports/${date}-memory-consolidation`
    write(`${path}.md`, markdown); write(`${path}.json`, '{}\n')
    git('add', '.'); git('commit', '--allow-empty', '-qm', checkpoint
      ? `chore: consolidate memory checkpoint (${date}) — steps 10-12` : `chore: consolidate memory (${date})`)
    const evidence = git('rev-parse', 'HEAD')
    if (consume) {
      rmSync(join(dir, `${path}.json`)); git('add', '-u'); git('commit', '-qm', 'consume JSON')
    }
    if (checkpoint && finalize) git('commit', '--allow-empty', '-qm', `chore: consolidate memory (${date})`)
    return { final: git('rev-parse', 'HEAD'), evidence, path }
  }
  const state = () => spawnSync('bash', [join(repo, 'scripts/consolidation-state.sh'), dir], { env, encoding: 'utf8' })
  return { dir, env, git, write, opts, stall, report, state }
}

test('targets are independent: either protected stall can defer while the other remains productive', t => {
  const f = fixture(t)
  for (const [stalled, productive] of [[claude, summary], [summary, claude]]) {
    f.report({ [stalled]: f.stall(stalled), [productive]: cleared('progress') })
    assert.equal(advise(f.dir, stalled, f.opts()).decision, 'deferred')
    assert.equal(advise(f.dir, productive, f.opts()).decision, 'search')
  }
})

test('168 elapsed hours, millisecond boundary, repeated completed deferrals never slide deadline', t => {
  const f = fixture(t)
  const entry = f.stall(summary)
  const options = { now: attempted + WEEK_MS - 1, inputFingerprint: entry.inputFingerprint }
  assert.equal(decide(entry, options).decision, 'deferred')
  assert.equal(decide(entry, { ...options, now: attempted + WEEK_MS }).decision, 'search')
  assert.equal(decide(entry, { ...options, now: attempted + WEEK_MS + 1 }).decision, 'search')
  f.report({ [summary]: entry })
  for (let day = 1; day <= 6; day++) {
    const result = advise(f.dir, summary, f.opts({ now: attempted + day * 86400000 }))
    assert.equal(result.decision, 'deferred')
    assert.deepEqual(result.entry, { ...entry, status: 'deferred' })
    f.report({ [summary]: result.entry }, { date: `2026-11-${14 + day}` })
  }
  assert.equal(advise(f.dir, summary, f.opts({ now: attempted + WEEK_MS })).decision, 'search')
})

test('same-size target edits invalidate; SUMMARY timestamp alone does not', t => {
  const f = fixture(t)
  f.report({ [summary]: f.stall(summary), [claude]: f.stall(claude) })
  const original = readFileSync(join(f.dir, summary))
  f.write(summary, original.toString().replace('2026-11-14 01:00', '2026-11-15 02:30'))
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'deferred')
  assert.equal(advise(f.dir, claude, f.opts()).decision, 'deferred')
  f.write(summary, original.toString().replace('unique', 'Unique'))
  assert.equal(readFileSync(join(f.dir, summary)).length, original.length)
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  f.write(summary, original)
  f.write(claude, readFileSync(join(f.dir, claude), 'utf8').replace('Identity', 'identity'))
  assert.equal(advise(f.dir, claude, f.opts()).decision, 'search')
})

test('Step 0 maintenance-only archival and SUMMARY refresh preserve both weekly stalls; new daily knowledge searches', t => {
  const f = fixture(t)
  const targets = [claude, summary]
  const yesterday = 'memory/daily/2026-11-14.md'
  const today = 'memory/daily/2026-11-15.md'
  f.write('memory/TODAY.md', '# 2026-11-14\n\n- 01:00 — memory consolidation started\n')
  f.write(yesterday, '# 2026-11-14\n\n- 00:59 — maintenance: consolidation session\n')
  const entries = Object.fromEntries(targets.map(target => [target, f.stall(target)]))
  f.report(entries, { checkpoint: true })
  const completedAt = f.git('rev-parse', 'HEAD')
  for (const target of targets) {
    assert.equal(advise(f.dir, target, f.opts({ completedAt, now: attempted })).decision, 'deferred')
  }
  f.write(yesterday, readFileSync(join(f.dir, yesterday), 'utf8') +
    '\n# 2026-11-14\n\n- 01:00 — memory consolidation started\n- 01:15 — memory consolidation completed\n')
  // Use log-write.ts's bracketed timestamp for the required maintenance entry.
  f.write(today, '# 2026-11-15\n\n- [00:59] maintenance: consolidation session\n')
  f.write('memory/TODAY.md', '# 2026-11-15\n\n- 01:00 — memory consolidation started\n')
  f.write(summary, readFileSync(join(f.dir, summary), 'utf8').replace('2026-11-14 01:00', '2026-11-15 01:00'))
  f.git('add', 'memory'); f.git('commit', '-qm', 'chore: consolidate memory checkpoint (2026-11-15) — step 0')
  for (const target of targets) {
    const result = advise(f.dir, target, f.opts({ completedAt }))
    assert.equal(result.decision, 'deferred', `${target}: ${result.reason}`)
    assert.deepEqual(result.entry, { ...entries[target], status: 'deferred' })
  }
  f.write(today, readFileSync(join(f.dir, today), 'utf8') + '- [02:00] New decision: retain customer audit evidence for 90 days.\n')
  for (const target of targets) {
    const result = advise(f.dir, target, f.opts({ completedAt }))
    assert.equal(result.decision, 'search')
    assert.equal(result.reason, 'decision inputs changed')
  }
})

const historyPath = 'memory/episodic/archive/consolidation-history-2026-H2.md'
const historyRecord = (date, start) => `\n## Consolidation ${date} / ${start}\nStatus: in progress\nWork performed: Reviewed all memory tiers; zero promotions; regenerated SUMMARY.md.\n<!-- /consolidation-history -->\n`

function historyFixture(t, previous) {
  const f = fixture(t)
  if (previous !== null) {
    f.write(historyPath, previous)
    f.git('add', 'memory'); f.git('commit', '-qm', 'legacy history')
  }
  const helper = (name, ...args) => {
    const r = spawnSync('bash', [join(repo, `scripts/consolidation-${name}.sh`), ...args], { env: f.env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return r.stdout
  }
  const start = date => {
    const head = f.git('rev-parse', 'HEAD')
    helper('marker', 'start', f.dir, date)
    return head
  }
  const append = (date, head) => {
    let before = ''
    try { before = readFileSync(join(f.dir, historyPath), 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    f.write(historyPath, before + historyRecord(date, head))
    helper('commit', f.dir, date, 'steps 5-6')
  }
  const finish = (date, head, targets) => {
    f.write(`reports/${date}-memory-consolidation.md`, block(targets))
    f.write(`reports/${date}-memory-consolidation.json`, JSON.stringify({ operationType: 'consolidation',
      consolidationHistory: { version: 1, cycleDate: date, startingHead: head } }))
    helper('commit', f.dir, date, 'steps 10-12')
    helper('commit', f.dir, date, 'final')
    assert.match(helper('state', f.dir), /complete/)
    helper('marker', 'clear', f.dir)
  }
  return { ...f, start, append, finish }
}

for (const previous of ['# Legacy history without a final newline: café', null]) {
  for (const target of [summary, claude]) {
    test(`history appends preserve ${target} stall across completed cycles (new archive=${previous === null})`, t => {
      const f = historyFixture(t, previous)
      const date = '2026-11-14'
      const head = f.start(date)
      // Production order: Step 6 attempts SUMMARY before the required append;
      // Step 9c attempts CLAUDE after the Step 6a checkpoint containing it.
      const entries = { [summary]: f.stall(summary) }
      f.append(date, head)
      entries[claude] = f.stall(claude)
      f.finish(date, head, entries)
      let result = advise(f.dir, target, f.opts({ now: attempted }))
      assert.equal(result.decision, 'deferred', `${target} after first final: ${result.reason}`)
      assert.deepEqual(result.entry, { ...entries[target], status: 'deferred' })

      // Two further valid appends at +24h, including independent same-day
      // cycles. Use the real marker/commit/state helpers at every boundary.
      for (let cycle = 0; cycle < 2; cycle++) {
        const nextDate = '2026-11-15'
        const completedAt = f.start(nextDate)
        const options = f.opts({ completedAt, now })
        result = advise(f.dir, target, options)
        assert.equal(result.decision, 'deferred', `${target} before append ${cycle}: ${result.reason}`)
        f.append(nextDate, completedAt)
        result = advise(f.dir, target, options)
        assert.equal(result.decision, 'deferred', `${target} after append ${cycle}: ${result.reason}`)
        assert.deepEqual(result.entry, { ...entries[target], status: 'deferred' })
        f.finish(nextDate, completedAt, { ...entries, [target]: result.entry })
        assert.equal(advise(f.dir, target, f.opts()).decision, 'deferred')
      }

      const source = readFileSync(join(f.dir, 'memory/semantic/project.md'), 'utf8')
      f.write('memory/semantic/project.md', source + 'New decision: retain audit evidence for 90 days.\n')
      assert.equal(advise(f.dir, target, f.opts()).decision, 'search', 'substantive source change')
      f.write('memory/semantic/project.md', source)
      assert.equal(advise(f.dir, target, f.opts()).decision, 'deferred')

      // Still matches the history schema, but edits the first, sealed record.
      const history = readFileSync(join(f.dir, historyPath), 'utf8')
      f.write(historyPath, history.replace('Reviewed all memory tiers', 'Reviewed new memory tiers'))
      assert.equal(advise(f.dir, target, f.opts()).decision, 'search', 'older record rewritten on disk')
      f.git('add', historyPath); f.git('commit', '-qm', 'rewrite older history record')
      assert.equal(advise(f.dir, target, f.opts()).decision, 'search', 'older record rewrite committed')
    })
  }
}

test('history normalization fails closed on uncertain appends and keeps explicit dependencies opaque', t => {
  const f = historyFixture(t, '# Legacy history\n')
  const head = f.start('2026-11-14')
  const entries = { [summary]: f.stall(summary) }
  f.append('2026-11-14', head)
  entries[claude] = f.stall(claude)
  f.finish('2026-11-14', head, entries)
  const completedAt = f.start('2026-11-15')
  const options = f.opts({ completedAt })
  const before = readFileSync(join(f.dir, historyPath), 'utf8')
  const suffix = historyRecord('2026-11-15', completedAt)
  const opaque = fingerprint(f.dir, summary, { ...options, dependencies: [historyPath] })
  for (const valid of [suffix, '\n \t' + suffix.trim(), suffix.trim()]) {
    f.write(historyPath, before + valid)
    for (const target of [summary, claude]) {
      assert.equal(advise(f.dir, target, options).decision, 'deferred', 'valid uncommitted append')
    }
  }
  assert.notEqual(fingerprint(f.dir, summary, { ...options, dependencies: [historyPath] }), opaque)
  for (const bad of [
    suffix.replace('Status: in progress', 'Status: completed'),
    suffix.replace('Work performed: Reviewed all memory tiers; zero promotions; regenerated SUMMARY.md.', 'Work performed: too short'),
    suffix.replace('Work performed: Reviewed all memory tiers; zero promotions; regenerated SUMMARY.md.', 'Work performed: ' + 'A'.repeat(30)),
    suffix.replace('2026-11-15', '2026-06-15'),
    suffix.replace('2026-11-15', '2026-11-31'),
    suffix.replace(completedAt, 'a'.repeat(40)),
    suffix.replace(completedAt, completedAt.slice(1)),
    suffix.replace('<!-- /consolidation-history -->', ''),
    suffix + suffix,
    suffix + 'Additional source knowledge.\n',
    Buffer.concat([Buffer.from(suffix), Buffer.from([0xff])]),
  ]) {
    f.write(historyPath, Buffer.concat([Buffer.from(before), Buffer.from(bad)]))
    for (const target of [summary, claude]) {
      assert.equal(advise(f.dir, target, options).decision, 'search', String(bad))
    }
  }
  f.write(historyPath, before + suffix)
  const marker = readFileSync(join(f.dir, '.git/consolidation-start'))
  rmSync(join(f.dir, '.git/consolidation-start'))
  for (const target of [summary, claude]) assert.equal(advise(f.dir, target, options).decision, 'search')
  f.write('.git/consolidation-start', marker)
  f.write(historyPath, before)
  for (const target of [summary, claude]) assert.equal(advise(f.dir, target, options).decision, 'deferred')
  f.write(historyPath, before.replace('# Legacy history', '# Edited history'))
  for (const target of [summary, claude]) assert.equal(advise(f.dir, target, options).decision, 'search')
})

test('removing committed history records or their archive requires search, including committed removals', t => {
  const f = historyFixture(t, null)
  const entries = {}
  for (let cycle = 0; cycle < 2; cycle++) {
    const head = f.start('2026-11-14')
    if (!cycle) {
      for (const target of [summary, claude]) entries[target] = f.stall(target)
    }
    f.append('2026-11-14', head)
    f.finish('2026-11-14', head, entries)
  }
  const original = readFileSync(join(f.dir, historyPath), 'utf8')
  const final = f.git('rev-parse', 'HEAD')
  const lastRecord = original.lastIndexOf('\n## Consolidation ')
  // Losing a trailing record must not resurrect the earlier normalized state.
  for (const content of [original.slice(0, lastRecord), '', null]) {
    if (content === null) rmSync(join(f.dir, historyPath))
    else f.write(historyPath, content)
    for (const target of [summary, claude]) assert.equal(advise(f.dir, target, f.opts()).decision, 'search')
    f.git('add', historyPath); f.git('commit', '-qm', 'remove history evidence')
    for (const target of [summary, claude]) assert.equal(advise(f.dir, target, f.opts()).decision, 'search')
    // Only this disposable fixture is reset between independent removal cases.
    f.git('reset', '--hard', final)
  }
})

test('daily filter has an exact allowlist and preserves substantive bytes in mixed archives', () => {
  const date = '2026-11-14'
  const normalize = text => normalizeDaily(Buffer.from(text), date)
  for (const ending of ['\n', '\r\n']) {
    for (const stamp of ['00:00 — ', '23:59 — ', '[01:30] ']) {
      for (const message of ['memory consolidation started', 'memory consolidation completed', 'maintenance: consolidation session']) {
        assert.equal(normalize(`# ${date}${ending}${ending}- ${stamp}${message}${ending}`), null)
      }
    }
  }
  const source = `# ${date}\n\n- [MEM-12] Preserve this **rule** exactly.\n\n- [02:00] A second source entry.\n`
  const mixed = source + '- [02:15] maintenance: consolidation session\n' +
    `\n# ${date}\n\n- 02:30 — memory consolidation started\n`
  assert.equal(normalize(mixed).toString(), source)
  assert.notDeepEqual(normalize(mixed.replace('this **rule**', 'that **rule**')), normalize(mixed))
  assert.notDeepEqual(normalize(mixed.replace('exactly.\n\n', 'exactly.\n')), normalize(mixed))
  for (const line of [
    '- [02:15] maintenance: consolidation session — learned a new rule\n',
    '- [02:15] maintenance: reflection session\n',
    '- [MEM-12] memory consolidation started\n',
    '- 24:00 — memory consolidation started\n',
    '- 01:60 — memory consolidation completed\n',
    '- 01:00 — memory consolidation started [REMEMBER]\n',
    '- 01:00 — Memory consolidation started\n',
    '- 01:00 — memory consolidation started',
  ]) {
    const text = `# ${date}\n\n${line}`
    assert.equal(normalize(text).toString(), text)
  }
})

test('daily uncertainty searches; only verified daily maintenance content and availability are excluded', t => {
  const f = fixture(t)
  const targets = [claude, summary]
  const path = 'memory/daily/2026-11-15.md'
  const maintenance = '# 2026-11-15\n\n- [00:59] maintenance: consolidation session\n'
  f.report(Object.fromEntries(targets.map(target => [target, f.stall(target)])))
  // Even creating the daily directory and its first maintenance-only file is inert.
  f.write(path, maintenance)
  for (const target of targets) assert.equal(advise(f.dir, target, f.opts()).decision, 'deferred')
  for (const text of [
    '# 2026-11-15\n', '', // absence of content is not proof of maintenance
    maintenance + '- [MEM-12] New knowledge\n',
    maintenance.replace('session\n', 'session: new policy\n'),
    maintenance.replace('2026-11-15', '2026-11-14'),
    maintenance.replace('# 2026-11-15\n\n', ''),
    maintenance.replace('- [00:59]', '```\n- [00:59]') + '```\n',
    maintenance + '- Detail\n  continued line\n',
    maintenance + '- <!--\n',
    maintenance + '- <script>\n',
    maintenance + '- ~~~\n',
    maintenance + '- `multi-line code\n',
    Buffer.concat([Buffer.from(maintenance), Buffer.from([0xff])]),
  ]) {
    f.write(path, text)
    for (const target of targets) assert.equal(advise(f.dir, target, f.opts()).decision, 'search', String(text))
  }
  for (const date of ['2026-02-30', '2026-99-99']) {
    assert.throws(() => normalizeDaily(Buffer.from(`# ${date}\n\n- [00:59] maintenance: consolidation session\n`), date), /uncertain/)
  }
  f.write(path, maintenance)
  // Extra dependencies are intentionally opaque, even if pointing at the same archive.
  assert.equal(advise(f.dir, summary, f.opts({ dependencies: [path] })).decision, 'search')
  for (const other of ['memory/daily/custom.md', 'memory/semantic/2026-11-15.md', 'memory/daily/nested/2026-11-15.md']) {
    f.write(other, maintenance)
    assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
    rmSync(join(f.dir, other))
  }
  rmSync(join(f.dir, 'memory/daily/nested'), { recursive: true })
  rmSync(join(f.dir, path))
  symlinkSync(join(f.dir, 'memory/TODAY.md'), join(f.dir, path))
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
})

test('source content, source availability and extra referenced/imported dependencies invalidate', t => {
  const f = fixture(t)
  const cases = [
    () => f.write('memory/semantic/project.md', 'Reference material\n'), // same size
    () => f.write('memory/semantic/new-source.md', 'new candidate'),
    () => rmSync(join(f.dir, 'memory/semantic/project.md')),
    () => f.write('memory/daily/2026-11-15.md', 'new candidate source'),
    () => f.write('memory/procedural/task.md', 'new workflow'),
    () => f.write('memory/core/LEARNINGS.md', 'new protection rule'),
    () => f.write('memory/MEM_REGISTRY.md', 'lifecycle/source eligibility changed'),
    () => f.write('memory/custom-source.md', 'new root source availability'),
  ]
  for (const mutate of cases) {
    f.report({ [summary]: f.stall(summary) })
    mutate()
    assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  }
  const dependencies = ['imported.md', 'custom-source-directory']
  const entry = { ...f.stall(summary), inputFingerprint: fingerprint(f.dir, summary, f.opts({ dependencies })) }
  f.report({ [summary]: entry })
  assert.equal(advise(f.dir, summary, f.opts({ dependencies })).decision, 'deferred')
  f.write('imported.md', 'external rule changed')
  assert.equal(advise(f.dir, summary, f.opts({ dependencies })).decision, 'search')
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search') // coverage list changed
})

test('policy content/version/threshold, review requests and uncertain coverage invalidate', t => {
  const f = fixture(t)
  const policyRoot = join(f.dir, 'policy')
  for (const path of policyFiles) {
    mkdirSync(join(policyRoot, path, '..'), { recursive: true })
    copyFileSync(join(repo, path), join(policyRoot, path))
  }
  const entry = { ...f.stall(summary), inputFingerprint: fingerprint(f.dir, summary, f.opts({ policyRoot })) }
  f.report({ [summary]: entry })
  assert.equal(advise(f.dir, summary, f.opts({ policyRoot })).decision, 'deferred')
  assert.equal(advise(f.dir, summary, f.opts({ policyRoot, reviewRequested: true })).decision, 'search')
  assert.equal(advise(f.dir, summary, f.opts({ coverageConfirmed: false })).decision, 'search')
  assert.equal(decide({ ...entry, policyVersion: 'reduction-retry-v2' }, { now, inputFingerprint: entry.inputFingerprint }).decision, 'search')
  for (const path of ['scripts/consolidation-history-schema.mjs', 'scripts/consolidation-marker.sh']) {
    const original = readFileSync(join(policyRoot, path))
    writeFileSync(join(policyRoot, path), 'changed history normalization policy')
    assert.equal(advise(f.dir, summary, f.opts({ policyRoot })).decision, 'search')
    writeFileSync(join(policyRoot, path), original)
    assert.equal(advise(f.dir, summary, f.opts({ policyRoot })).decision, 'deferred')
  }
  writeFileSync(join(policyRoot, 'skills/memory/consolidate/SKILL.md'), 'new reduction policy')
  assert.equal(advise(f.dir, summary, f.opts({ policyRoot })).decision, 'search')
  const cap = CAPS[summary]
  const beforeThreshold = fingerprint(f.dir, summary, f.opts())
  try {
    CAPS[summary]++
    assert.notEqual(fingerprint(f.dir, summary, f.opts()), beforeThreshold)
    assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  } finally { CAPS[summary] = cap }
})

test('missing, corrupt, incompatible, future or inconsistent retry data always searches', t => {
  const f = fixture(t)
  const entry = f.stall(summary)
  for (const override of [null, {}, { ...entry, status: 'unknown' }, { ...entry, reviewReason: '' },
    { ...entry, lastAttemptAt: new Date(now + 1).toISOString(), nextEligibleAt: new Date(now + 1 + WEEK_MS).toISOString() },
    { ...entry, nextEligibleAt: new Date(attempted + WEEK_MS + 1).toISOString() },
    { ...entry, lastAttemptAt: '2026-02-30T01:00:00.000Z' }, { ...entry, inputFingerprint: 'oops' },
    { ...entry, lastAttemptAt: null }, { ...entry, nextEligibleAt: null }]) {
    f.report({ [summary]: override })
    assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  }
  for (const markdown of ['narrative: structurally stalled', '```consolidation-retry-v1\n{bad json\n```',
    block({ [summary]: entry }) + block({ [summary]: entry }),
    block({ [summary]: entry }) + '```consolidation-retry-v2\n{}\n```\n',
    block({ [summary]: entry }).replace('"version":1', '"version":2')]) {
    f.report({}, { markdown })
    assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  }
  assert.throws(() => parseRetryBlock('```json\n{}\n```'))
})

test('ambiguous/failed/no-progress/budget-exhausted/productive/under-cap outcomes clear stale backoff', t => {
  const f = fixture(t)
  for (const status of ['ambiguous', 'failed-preservation', 'interrupted', 'no-progress', 'budget-exhausted', 'progress', 'under-cap']) {
    // Even accidental leftover timestamps may not convert these to stalls.
    const entry = { ...f.stall(summary), status }
    f.report({ [summary]: entry })
    assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  }
  f.report({ [claude]: f.stall(claude) })
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search') // absent entry never falls back
})

test('committed markdown survives JSON consumption at final or 12a, ignoring working draft advice', t => {
  const f = fixture(t)
  f.report({ [summary]: f.stall(summary) }, { consume: true })
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'deferred')
  const completed = f.report({ [summary]: f.stall(summary) }, { date: '2026-11-15', checkpoint: true, consume: true })
  assert.equal(completedReport(f.dir, completed.final).evidence, completed.evidence)
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'deferred')
  f.report({ [summary]: cleared('progress') }, { date: '2026-11-16' })
  f.write('reports/2026-11-16-memory-consolidation.md', block({ [summary]: f.stall(summary) }))
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  assert.equal(f.state().status, 1) // dirty report must be inspected, never bypassed by retry advice
})

test('newest final without valid pair/block never resurrects an older stall; checkpoint alone is incomplete', t => {
  const f = fixture(t)
  f.report({ [summary]: f.stall(summary) })
  f.report({}, { date: '2026-11-15', markdown: 'legacy report without retry metadata' })
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  f.git('commit', '--allow-empty', '-qm', 'chore: consolidate memory (2026-11-16)')
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  const start = f.git('rev-parse', 'HEAD')
  f.write('.git/consolidation-start', `v1 2026-11-17 ${start}\n`)
  f.write('reports/2026-11-17-memory-consolidation.md', block({ [summary]: f.stall(summary) }))
  f.write('reports/2026-11-17-memory-consolidation.json', '{}')
  f.git('add', 'reports'); f.git('commit', '-qm', 'chore: consolidate memory checkpoint (2026-11-17) — steps 10-12')
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  const state = f.state()
  assert.equal(state.status, 1)
  assert.match(state.stdout, /inspect.*repair/)
})

test('changed markdown between 12a and final cannot borrow consumed JSON completion evidence', t => {
  const f = fixture(t)
  const completed = f.report({ [summary]: f.stall(summary) }, { checkpoint: true, consume: true, finalize: false })
  f.write(`${completed.path}.md`, block({ [summary]: f.stall(summary) }) + 'unverified final changes\n')
  f.git('add', 'reports'); f.git('commit', '-qm', 'chore: consolidate memory (2026-11-14)')
  const result = advise(f.dir, summary, f.opts())
  assert.equal(result.decision, 'search')
  assert.match(result.reason, /markdown differs/)
})

test('retry section leaves Tier Coverage idle detection intact; due retries never force idle/disabled maintenance', t => {
  const f = fixture(t)
  const date = new Date(Date.now() - 72 * 3600000).toISOString().slice(0, 10)
  const lastAttempt = Date.now() - 8 * 86400000
  const due = target => ({ ...f.stall(target), lastAttemptAt: new Date(lastAttempt).toISOString(),
    nextEligibleAt: new Date(lastAttempt + WEEK_MS).toISOString() })
  const targets = { [summary]: due(summary), [claude]: due(claude) }
  const markdown = '# Completed report\n\n## Tier Coverage\n' +
    ['core', 'semantic', 'episodic', 'procedural'].map(tier => `- ${tier}/: No new content — confirmed ✅\n`).join('') +
    '\n' + block(targets)
  f.report({}, { date, markdown })
  assert.match(advise(f.dir, summary, f.opts({ now: Date.now() })).reason, /168-hour deadline reached/)
  const guard = () => spawnSync('bash', [join(repo, 'scripts/maintenance-guard.sh'), f.dir], {
    env: { ...f.env, CONSOLIDATION_IDLE_STREAK_MIN: '1', CONSOLIDATION_IDLE_FALLBACK_HOURS: '168',
      CONSOLIDATION_WINDOW_START: '0', CONSOLIDATION_WINDOW_END: '24' }, encoding: 'utf8',
  })
  let result = guard()
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /idle-skip/)
  f.write('MAINTENANCE_DISABLED', '')
  result = guard()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /maintenance_disabled/)
})

test('uncertain normalization, symlink coverage, absent history and shallow history cannot defer', t => {
  const f = fixture(t)
  f.report({ [summary]: f.stall(summary) })
  const original = readFileSync(join(f.dir, summary), 'utf8')
  for (const text of [original.replace('**Last consolidated:**', 'Last consolidated:'),
    original + '**Last consolidated:** 2026-11-15 01:00 UTC\n', original.replace(' UTC', ' local'),
    original.replace('2026-11-14 01:00', '2026-99-99 99:99')]) {
    f.write(summary, text)
    assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  }
  f.write(summary, original)
  symlinkSync(join(f.dir, claude), join(f.dir, 'memory/semantic/link.md'))
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
  rmSync(join(f.dir, 'memory/semantic/link.md'))
  assert.equal(advise(f.dir, summary, f.opts({ completedAt: '0'.repeat(40) })).decision, 'search')
  f.write('.git/shallow', f.git('rev-parse', 'HEAD') + '\n')
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'search')
})

test('a merged newer completion cannot resurrect first-parent stall metadata', t => {
  const f = fixture(t)
  f.report({ [summary]: f.stall(summary) })
  const base = f.git('rev-parse', 'HEAD')
  f.git('checkout', '-qb', 'new-completion')
  f.report({ [summary]: cleared('progress') }, { date: '2026-11-15' })
  f.git('checkout', '--detach', base)
  f.write('user.md', 'independent work')
  f.git('add', 'user.md'); f.git('commit', '-qm', 'user work')
  f.git('merge', '--no-ff', '-m', 'merge newer completion', 'new-completion')
  const result = advise(f.dir, summary, f.opts())
  assert.equal(result.decision, 'search')
  assert.match(result.reason, /merged completion history/)
})

test('CLI advice is read-only and generated bookkeeping does not invalidate', t => {
  const f = fixture(t)
  f.report({ [summary]: f.stall(summary) })
  f.write('memory/episodic/consolidation-progress-2026-11-15.md', 'in progress, never reduction source')
  f.write('memory/TODAY.md', 'automatic maintenance timestamp')
  f.write('memory/.last_consolidation', 'publication timestamp')
  // Parent directory availability itself is relevant; create it before recording a stall.
  f.report({ [summary]: f.stall(summary) })
  f.write('memory/episodic/consolidation-progress-2026-11-16.md', 'new bookkeeping')
  symlinkSync(join(repo, 'scripts/consolidation-retry.mjs'), join(f.dir, 'retry-link.mjs'))
  const before = { head: f.git('rev-parse', 'HEAD'), index: readFileSync(join(f.dir, '.git/index')),
    diff: f.git('diff', '--binary'), status: f.git('status', '--porcelain') }
  const cli = spawnSync(process.execPath, [join(repo, 'scripts/consolidation-retry.mjs'), f.dir, summary,
    '--completed-at', before.head, '--coverage-confirmed'], { env: f.env, encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).target, summary)
  const linked = spawnSync(process.execPath, [join(f.dir, 'retry-link.mjs'), f.dir, summary,
    '--completed-at', before.head, '--coverage-confirmed'], { env: f.env, encoding: 'utf8' })
  assert.equal(linked.status, 0, linked.stderr)
  assert.equal(JSON.parse(linked.stdout).target, summary)
  assert.equal(advise(f.dir, summary, f.opts()).decision, 'deferred')
  assert.deepEqual({ head: f.git('rev-parse', 'HEAD'), index: readFileSync(join(f.dir, '.git/index')),
    diff: f.git('diff', '--binary'), status: f.git('status', '--porcelain') }, before)
})

test('documented deferral preserves required work, bounded reduction and whole-run authorization', () => {
  const skill = readFileSync(join(repo, 'skills/memory/consolidate/SKILL.md'), 'utf8')
  const maintenance = readFileSync(join(repo, 'MAINTENANCE.md'), 'utf8')
  assert.match(skill, /Narrow exception \(#466\).*only the reduction candidate searches/)
  assert.match(skill, /Always regenerate `memory\/SUMMARY.md` on every consolidation run/)
  assert.match(skill, /min\(3, ceil\(S \/ 9000\)\)/)
  assert.match(skill, /result is \*\*strictly smaller\*\*/)
  assert.match(skill, /Never mark ACTIVE memories obsolete to meet the cap/)
  assert.match(skill, /Never move\* identity sections, `@` import lines, or core behavioral rules/)
  assert.match(skill, /Step 9b measurements and warnings remain required/)
  assert.match(skill, /skip only the loop below.*0 used \/ the fixed allowed budget/)
  assert.match(skill, /pointer reconciliation, prior attempt and unchanged next-eligible time/)
  assert.match(skill, /selfAssessment\["summary-md-regenerated"\] = true/)
  assert.match(maintenance, /SUMMARY still regenerates.*reconciles\/validates pointers.*`filesChanged`/)
  assert.match(maintenance, /This never schedules or forces an idle\/disabled brain to run/)
  assert.match(maintenance, /completion\/repair guard/)
})
