// Unit tests for the pb#124 delivery-target surfacing (option B): the
// create_scheduled_message response echoes a `delivery` block so the agent can
// verify a scheduled message reaches the intended recipient before trusting it.
// teamvibe-api.mjs auto-starts a stdio server at the transport section, so we
// load just the prelude (everything before the JSON-RPC section) as a module and
// export the pure helper. No network, no stdin.
// Run: node mcp/__tests__/teamvibe-api-delivery.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'teamvibe-api.mjs'), 'utf8')
const prelude = src.split('// --- JSON-RPC 2.0 / MCP protocol ---')[0]
const exports = '\nexport { buildDeliveryInfo }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { buildDeliveryInfo } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

// 1) inherited from session (the pb#124 failure shape) → flagged, channel echoed, warning present
{
  const d = buildDeliveryInfo({ source: 'slack', channel: 'D_KUBA_DM', thread_ts: undefined }, false)
  ok('1 channel echoed', d.channel === 'D_KUBA_DM')
  ok('1 resolvedFrom = inherited', d.resolvedFrom === 'inherited-from-current-session')
  ok('1 note warns about different recipient', /different channel\/recipient/.test(d.note))
}
// 2) explicit origin → marked explicit, no inheritance warning
{
  const d = buildDeliveryInfo({ source: 'slack', channel: 'C_PROJECT', thread_ts: '123.456' }, true)
  ok('2 channel echoed', d.channel === 'C_PROJECT')
  ok('2 thread_ts echoed', d.thread_ts === '123.456')
  ok('2 resolvedFrom = explicit', d.resolvedFrom === 'explicit-origin')
  ok('2 note = explicit, no warning', d.note === 'Delivery channel C_PROJECT (explicit).')
}
// 3) no origin resolved → resolvedFrom none, fallback note, null channel (never throws)
{
  const d = buildDeliveryInfo(undefined, false)
  ok('3 channel null', d.channel === null)
  ok('3 thread_ts null', d.thread_ts === null)
  ok('3 resolvedFrom = none', d.resolvedFrom === 'none')
  ok('3 note = channel default fallback', /fall back to the channel default/.test(d.note))
}
// 4) explicit origin object without a channel → explicit but null channel (no crash, honest fallback note)
{
  const d = buildDeliveryInfo({ source: 'slack' }, true)
  ok('4 channel null', d.channel === null)
  ok('4 resolvedFrom = explicit', d.resolvedFrom === 'explicit-origin')
  ok('4 note = fallback', /fall back to the channel default/.test(d.note))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
