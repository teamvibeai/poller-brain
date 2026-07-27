// Unit tests for computeThreadOverrideWarning() — the pure decision behind the
// `thread_ts_override_unjustified` warning (teamvibeai/teamvibe.ai#184, phase 1).
// Locks the smoke cases from the issue AC:
//   #1 explicit foreign thread_ts, no in-text reference  → warning fires
//   #2 triggering message references the target thread   → suppressed (signal C)
//   #3 thread_ts: null (broadcast)                       → suppressed (exception 4)
//   #4 cold start / scheduled (no session thread)        → suppressed (exception 1)
// plus the default path (thread_ts omitted) which must stay untouched.
// slack.mjs auto-starts a stdio server on import, so we load just the pure
// prelude (everything before the transport section) and export-by-eval the
// helpers. No network, no Slack. Run: node mcp/__tests__/slack-threadts-warning.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'slack.mjs'), 'utf8')
const prelude = src.split('// --- stdio transport ---')[0]
const exports = '\nexport { computeThreadOverrideWarning, referencesThreadTs }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { computeThreadOverrideWarning, referencesThreadTs } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

// The exhibit case from the issue: J.A.R.V.I.S woke on the `run` thread and
// replied into the `briefing` thread recalled from a prior session.
const RUN = '1780639227.036509'      // session current thread
const BRIEFING = '1780637428.794809' // thread recalled from memory

// #1 — the bug this guardrail exists to catch
{
  const w = computeThreadOverrideWarning({
    explicitThreadTs: BRIEFING,
    sessionThreadTs: RUN,
    triggerText: '@jarvis dalsi hawk rebalance?',
  })
  ok('#1 warning fires on unreferenced foreign thread_ts', w !== null)
  ok('#1 code is thread_ts_override_unjustified', w?.code === 'thread_ts_override_unjustified')
  ok('#1 carries both timestamps', w?.session_thread_ts === RUN && w?.override_thread_ts === BRIEFING)
  ok('#1 detail gives the chat.delete recovery', w?.detail.includes('chat.delete'))
  ok('#1 detail admits the missing recent-wake signal', w?.detail.includes('recently'))
}

// #2 — signal C: the user pointed at the other thread themselves
{
  const raw = computeThreadOverrideWarning({
    explicitThreadTs: BRIEFING,
    sessionThreadTs: RUN,
    triggerText: `odpovez prosim v threadu ${BRIEFING}`,
  })
  ok('#2 suppressed when trigger text has the raw ts', raw === null)

  const permalink = computeThreadOverrideWarning({
    explicitThreadTs: BRIEFING,
    sessionThreadTs: RUN,
    triggerText: 'viz https://teamvibe.slack.com/archives/C0AKRUB4MS7/p1780637428794809',
  })
  ok('#2 suppressed on a thread-parent permalink (p<ts> path segment)', permalink === null)

  // A permalink to a *reply* carries the reply's ts in `p<ts>` and the thread's
  // ts only in the query param — the raw-ts check is what catches this one.
  const replyPermalink = computeThreadOverrideWarning({
    explicitThreadTs: BRIEFING,
    sessionThreadTs: RUN,
    triggerText: `https://teamvibe.slack.com/archives/C0AKRUB4MS7/p1780638000123456?thread_ts=${BRIEFING}&cid=C0AKRUB4MS7`,
  })
  ok('#2 suppressed on a reply permalink (?thread_ts= query param)', replyPermalink === null)
}

// signal A normalization — a stray space or a numeric ts must not read as a
// foreign thread (DevGuru review #2)
{
  const padded = computeThreadOverrideWarning({
    explicitThreadTs: ` ${RUN} `,
    sessionThreadTs: RUN,
    triggerText: 'cokoliv',
  })
  ok('signal A: whitespace-padded ts equals the session thread', padded === null)

  const blank = computeThreadOverrideWarning({
    explicitThreadTs: '   ',
    sessionThreadTs: RUN,
    triggerText: 'cokoliv',
  })
  ok('signal A: blank ts is not treated as a foreign thread', blank === null)

  const w = computeThreadOverrideWarning({
    explicitThreadTs: ` ${BRIEFING} `,
    sessionThreadTs: RUN,
    triggerText: 'cokoliv',
  })
  ok('signal A: payload carries the normalized ts', w?.override_thread_ts === BRIEFING)
}

// #3 — explicit top-level broadcast
{
  const w = computeThreadOverrideWarning({
    explicitThreadTs: null,
    sessionThreadTs: RUN,
    triggerText: 'posli to do kanalu',
  })
  ok('#3 thread_ts: null never warns (broadcast pattern)', w === null)
}

// #4 — cold start / scheduled message: no session thread to deviate from
{
  const undef = computeThreadOverrideWarning({
    explicitThreadTs: BRIEFING,
    sessionThreadTs: undefined,
    triggerText: '',
  })
  const empty = computeThreadOverrideWarning({
    explicitThreadTs: BRIEFING,
    sessionThreadTs: '',
    triggerText: '',
  })
  ok('#4 no warning when session thread is undefined', undef === null)
  ok('#4 no warning when session thread is empty', empty === null)
}

// default path — omitting thread_ts must stay a pure no-op
{
  const w = computeThreadOverrideWarning({
    explicitThreadTs: undefined,
    sessionThreadTs: RUN,
    triggerText: 'cokoliv',
  })
  ok('default path (thread_ts omitted) never warns', w === null)
}

// no-op override — same thread passed explicitly
{
  const w = computeThreadOverrideWarning({
    explicitThreadTs: RUN,
    sessionThreadTs: RUN,
    triggerText: 'cokoliv',
  })
  ok('explicit thread_ts equal to session thread never warns', w === null)
}

// unknown trigger text is treated as "no reference" — the caller is the one
// that must decide to stay silent (resolveThreadOverrideWarning does)
{
  const w = computeThreadOverrideWarning({
    explicitThreadTs: BRIEFING,
    sessionThreadTs: RUN,
    triggerText: null,
  })
  ok('null triggerText leaves the decision to the caller (warning returned)', w !== null)
}

// referencesThreadTs unit coverage
{
  ok('ref: raw ts matches', referencesThreadTs(`a ${BRIEFING} b`, BRIEFING))
  ok('ref: permalink form matches', referencesThreadTs('.../p1780637428794809', BRIEFING))
  ok('ref: unrelated text does not match', !referencesThreadTs('nic tu neni', BRIEFING))
  ok('ref: empty text does not match', !referencesThreadTs('', BRIEFING))
  ok('ref: missing thread ts does not match', !referencesThreadTs('cokoliv', null))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
