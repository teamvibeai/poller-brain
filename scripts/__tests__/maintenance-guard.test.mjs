// Run: node --test scripts/__tests__/maintenance-guard.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const zeroPromotion = `## Tier Coverage
- core/ (corrections, preferences, lessons): No new content — confirmed ✅
- semantic/ (facts, knowledge): No new content — confirmed ✅
- episodic/ (significant events): No significant events — confirmed ✅
- procedural/ (workflows): No new workflows — confirmed ✅
`

function dateAgo(days) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function brain(t, { today, newestDaysAgo = 3, promoted = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'reports'))
  for (const days of [newestDaysAgo + 1, newestDaysAgo]) {
    const report = promoted && days === newestDaysAgo
      ? zeroPromotion.replace('No new content — confirmed ✅', 'Updated core/PREFERENCES.md with MEM-12 ✅')
      : zeroPromotion
    writeFileSync(join(dir, 'reports', `${dateAgo(days)}-memory-consolidation.md`), report)
  }
  if (today !== undefined) {
    mkdirSync(join(dir, 'memory'))
    writeFileSync(join(dir, 'memory', 'TODAY.md'), today)
  }
  return dir
}

function guard(dir, overrides = {}) {
  // Isolate all policy knobs from the caller; UTC avoids date-boundary drift.
  const result = spawnSync('bash', ['scripts/maintenance-guard.sh', dir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TZ: 'UTC',
      CONSOLIDATION_WINDOW_START: '0',
      CONSOLIDATION_WINDOW_END: '24',
      CONSOLIDATION_IDLE_STREAK_MIN: '2',
      CONSOLIDATION_IDLE_FALLBACK_HOURS: '168',
      CONSOLIDATION_ACTIVITY_MEM_MIN: '1',
      CONSOLIDATION_ACTIVITY_DAYS_MIN: '2',
      CONSOLIDATION_ACTIVITY_BYTES_MIN: '32768',
      ...overrides,
    },
  })
  assert.ifError(result.error)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim().split('\n').length, 1)
  return result
}

const singleDay = () => `# ${dateAgo(0)}\n`
const memLines = (count) => singleDay() + Array.from({ length: count }, (_, i) => `- [MEM-${i + 12}] preference: remember this\n`).join('')

test('T1: one promotable MEM line overrides the idle streak', (t) => {
  const result = guard(brain(t, { today: memLines(1) }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle streak ignored: 1 \[MEM\] lines in TODAY\.md/)
})

test('T2: routine single-day logs still idle-skip', (t) => {
  const result = guard(brain(t, { today: singleDay() + '- [10:00] log: routine\n'.repeat(3) }))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /idle-skip/)
})

test('T3: two distinct date headings override the idle streak', (t) => {
  const result = guard(brain(t, { today: `# ${dateAgo(1)}\n${singleDay()}` }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle streak ignored: 2 distinct date headings in TODAY\.md/)
})

test('T4: 40 KB of routine logs override the idle streak', (t) => {
  const today = singleDay() + '- [10:00] log: routine\n'.repeat(2000)
  assert.ok(Buffer.byteLength(today) >= 40 * 1024)
  const result = guard(brain(t, { today }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle streak ignored: \d+ bytes in TODAY\.md/)
})

test('T5: missing TODAY.md still idle-skips', (t) => {
  const result = guard(brain(t))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /idle-skip/)
})

test('T6: activity never overrides the recent-run rule', (t) => {
  const result = guard(brain(t, { today: memLines(10), newestDaysAgo: 0 }))
  assert.equal(result.status, 1, result.stdout)
  // BSD date preserves the current hour (0h elapsed); GNU uses midnight.
  assert.match(result.stdout, /last ran (?:[0-9]|1[0-9]|2[0-3])h ago, threshold 24h/)
  if (process.platform === 'darwin') assert.match(result.stdout, /last ran 0h ago/)
  assert.doesNotMatch(result.stdout, /idle streak ignored|idle-skip/)
})

test('T7: a promoted tier still breaks the report-based idle streak', (t) => {
  const result = guard(brain(t, { promoted: true }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /overdue/)
  assert.doesNotMatch(result.stdout, /idle streak ignored/)
})

for (const count of [2, 3]) {
  test(`T8: MEM minimum of 3 with ${count} MEM lines`, (t) => {
    const result = guard(brain(t, { today: memLines(count) }), { CONSOLIDATION_ACTIVITY_MEM_MIN: '3' })
    assert.equal(result.status, count === 3 ? 0 : 1, result.stdout)
    assert.match(result.stdout, count === 3 ? /idle streak ignored: 3 \[MEM\] lines/ : /idle-skip/)
  })
}

test('repeated headings for one date do not count as multiple days', (t) => {
  const result = guard(brain(t, { today: singleDay().repeat(3) }))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /idle-skip/)
})

for (const count of [2, 3]) {
  test(`date heading minimum of 3 with ${count} distinct dates`, (t) => {
    const today = Array.from({ length: count }, (_, i) => `# ${dateAgo(i)}\n`).join('')
    const result = guard(brain(t, { today }), { CONSOLIDATION_ACTIVITY_DAYS_MIN: '3' })
    assert.equal(result.status, count === 3 ? 0 : 1, result.stdout)
    assert.match(result.stdout, count === 3 ? /3 distinct date headings/ : /idle-skip/)
  })
}

for (const extraByte of [0, 1]) {
  test(`byte minimum at actual UTF-8 size + ${extraByte}`, (t) => {
    const today = singleDay() + '- [10:00] log: příliš žluťoučký\n'
    const size = Buffer.byteLength(today)
    const result = guard(brain(t, { today }), { CONSOLIDATION_ACTIVITY_BYTES_MIN: String(size + extraByte) })
    assert.equal(result.status, extraByte === 0 ? 0 : 1, result.stdout)
    assert.match(result.stdout, extraByte === 0 ? new RegExp(`${size} bytes in TODAY\\.md`) : /idle-skip/)
  })
}

for (const inside of [true, false]) {
  test(`24–48h activity follows the time window (${inside ? 'inside' : 'outside'})`, (t) => {
    const result = guard(brain(t, { today: memLines(1), newestDaysAgo: 1 }), {
      CONSOLIDATION_WINDOW_START: inside ? '0' : '24',
      CONSOLIDATION_WINDOW_END: inside ? '24' : '25',
    })
    assert.equal(result.status, inside ? 0 : 1, result.stdout)
    assert.match(result.stdout, inside ? /inside window/ : /outside window/)
    assert.match(result.stdout, /idle streak ignored: 1 \[MEM\] lines/)
  })
}

test('168h idle fallback still forces a check-in without activity', (t) => {
  const result = guard(brain(t, { newestDaysAgo: 8 }))
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle but overdue.*forcing check-in run/)
})

test('noncanonical MEM-like prose is not promotable activity', (t) => {
  const today = singleDay() + '[MEM-12] prose\n- [MEM-feedback] prose\n - [MEM-13] indented\n'
  const result = guard(brain(t, { today }))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /idle-skip/)
})

test('activity detection failure falls through to the time policy', (t) => {
  const dir = brain(t, { today: memLines(1) })
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'awk'), '#!/bin/bash\nexit 2\n', { mode: 0o755 })
  const result = guard(dir, { PATH: `${bin}:${process.env.PATH}` })
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /idle streak ignored: cannot read TODAY\.md activity/)
})
