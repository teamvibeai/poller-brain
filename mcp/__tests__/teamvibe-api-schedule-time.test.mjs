#!/usr/bin/env node
// Unit tests for formatLocalTime() / annotateSchedule() — the schedule timestamp
// rendering added for #240 (follow-up to the #145 false positive).
//
// The load-bearing case is #145 itself: a schedule that ran correctly was reported
// as having skipped a Thursday. Rendered in its own timezone with the weekday, the
// report refutes itself. If that assertion ever fails, the fix stopped working.
//
// teamvibe-api.mjs auto-starts a stdio server on import, so we load just the pure
// prelude (everything before the transport section) and export-by-eval the helpers.
// No network, no API. Run: node mcp/__tests__/teamvibe-api-schedule-time.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'teamvibe-api.mjs'), 'utf8')
const prelude = src
  .split('// --- JSON-RPC 2.0 / MCP protocol ---')[0]
  .split('\n')
  .filter((l) => !l.startsWith('import '))
  .join('\n')
const exports = '\nexport { formatLocalTime, annotateSchedule }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { formatLocalTime, annotateSchedule } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }
const eq = (n, actual, expected) => {
  if (actual === expected) { pass++; console.log('  ✓', n) }
  else { fail++; console.log('  ✗ FAIL', n, '\n      expected:', expected, '\n      actual:  ', actual) }
}

console.log('formatLocalTime — weekday + wall clock in the schedule timezone')
{
  // #145: "skipped Thursday 2026-05-29". lastRunAt renders as Thursday 18:00 Prague,
  // i.e. the Thursday run happened; 2026-05-29 was a Friday, which `1-4` excludes.
  eq('#145 lastRunAt is Thursday in Europe/Prague',
    formatLocalTime('2026-05-28T16:00:17Z', 'Europe/Prague'),
    'Thu 2026-05-28 18:00:17 (Europe/Prague)')
  eq('#145 nextRunAt is Monday in Europe/Prague',
    formatLocalTime('2026-06-01T16:00:00Z', 'Europe/Prague'),
    'Mon 2026-06-01 18:00:00 (Europe/Prague)')

  // The date the report claimed was a Thursday.
  ok('2026-05-29 renders as Friday, not Thursday',
    formatLocalTime('2026-05-29T16:00:00Z', 'Europe/Prague').startsWith('Fri '))
}

console.log('formatLocalTime — offsets, DST and midnight')
{
  eq('missing timezone falls back to UTC and says so',
    formatLocalTime('2026-05-28T16:00:17Z', undefined),
    'Thu 2026-05-28 16:00:17 (UTC)')
  eq('CET (winter, UTC+1)',
    formatLocalTime('2026-01-15T08:00:00Z', 'Europe/Prague'),
    'Thu 2026-01-15 09:00:00 (Europe/Prague)')
  eq('CEST (summer, UTC+2)',
    formatLocalTime('2026-07-15T08:00:00Z', 'Europe/Prague'),
    'Wed 2026-07-15 10:00:00 (Europe/Prague)')
  // Crossing local midnight is where a UTC-only reading flips the weekday.
  eq('UTC evening is already the next day in Tokyo',
    formatLocalTime('2026-05-28T16:00:00Z', 'Asia/Tokyo'),
    'Fri 2026-05-29 01:00:00 (Asia/Tokyo)')
  eq('midnight renders as 00, not 24',
    formatLocalTime('2026-05-28T22:00:00Z', 'Europe/Prague'),
    'Fri 2026-05-29 00:00:00 (Europe/Prague)')
}

console.log('formatLocalTime — refuses to guess')
{
  ok('unknown IANA zone annotates nothing', formatLocalTime('2026-05-28T16:00:17Z', 'Mars/Olympus') === undefined)
  ok('unparseable timestamp annotates nothing', formatLocalTime('not-a-date', 'Europe/Prague') === undefined)
  ok('empty string annotates nothing', formatLocalTime('', 'Europe/Prague') === undefined)
  ok('null annotates nothing', formatLocalTime(null, 'Europe/Prague') === undefined)
  ok('non-string annotates nothing', formatLocalTime(1748448017000, 'Europe/Prague') === undefined)
}

console.log('annotateSchedule — additive, ordered, defensive')
{
  const row = {
    scheduleId: '01KP8M2VNCXHK3VB1TFES48YJE',
    scheduleType: 'CRON',
    cronExpression: '0 18 * * 1-4',
    timezone: 'Europe/Prague',
    status: 'ACTIVE',
    lastRunAt: '2026-05-28T16:00:17Z',
    nextRunAt: '2026-06-01T16:00:00Z',
    promptTemplate: 'x'.repeat(5000),
  }
  const out = annotateSchedule(row)

  eq('lastRunAtLocal added', out.lastRunAtLocal, 'Thu 2026-05-28 18:00:17 (Europe/Prague)')
  eq('nextRunAtLocal added', out.nextRunAtLocal, 'Mon 2026-06-01 18:00:00 (Europe/Prague)')
  eq('original lastRunAt untouched', out.lastRunAt, row.lastRunAt)
  eq('original nextRunAt untouched', out.nextRunAt, row.nextRunAt)
  eq('promptTemplate untouched', out.promptTemplate, row.promptTemplate)
  ok('input not mutated', row.lastRunAtLocal === undefined)

  // Response-shape rule: promptTemplate has no ceiling, so anything below it is what
  // a truncated log drops first. Annotations must sit above it.
  const keys = Object.keys(out)
  ok('annotations precede promptTemplate',
    keys.indexOf('lastRunAtLocal') < keys.indexOf('promptTemplate') &&
    keys.indexOf('nextRunAtLocal') < keys.indexOf('promptTemplate'))
}

{
  // ONE_TIME rows are stored with timezone: null (the API drops it for non-CRON).
  const out = annotateSchedule({
    scheduleType: 'ONE_TIME',
    timezone: null,
    scheduledAt: '2026-05-29T07:30:00Z',
    status: 'ACTIVE',
  })
  eq('scheduledAt rendered in UTC when the row has no timezone',
    out.scheduledAtLocal, 'Fri 2026-05-29 07:30:00 (UTC)')
  ok('no nextRunAtLocal invented when nextRunAt is absent', out.nextRunAtLocal === undefined)
}

{
  const noTimes = { scheduleId: 'x', status: 'PAUSED' }
  ok('row with no timestamps returned unchanged', annotateSchedule(noTimes) === noTimes)
  ok('null passes through', annotateSchedule(null) === null)
  ok('array passes through', Array.isArray(annotateSchedule([1, 2])))
  ok('string passes through', annotateSchedule('nope') === 'nope')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
