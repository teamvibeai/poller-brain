// Unit tests for the set_expected_duration tool handler (tv#32 Layer B).
// This tool makes no Slack API call — it's purely a signal the poller reads
// off the stdout stream — so handleTool() for this one case is safe to call
// directly without mocking network I/O. Same load-the-prelude trick as
// slack-payload.test.mjs since slack.mjs auto-starts a stdio server on import.
// Run: node mcp/__tests__/slack-expected-duration.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'slack.mjs'), 'utf8')
const prelude = src.split('// --- stdio transport ---')[0]
const exports = '\nexport { handleTool, TOOLS }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { handleTool, TOOLS } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

{
  const r = await handleTool('set_expected_duration', { minutes: 12 })
  ok('accepts a positive number, echoes it back', r.ok === true && r.minutes === 12)
}

{
  const r = await handleTool('set_expected_duration', { minutes: '7' })
  ok('coerces a numeric string', r.ok === true && r.minutes === 7)
}

for (const bad of [0, -5, NaN, 'not-a-number', undefined]) {
  let threw = false
  try {
    await handleTool('set_expected_duration', { minutes: bad })
  } catch {
    threw = true
  }
  ok(`rejects invalid minutes: ${bad}`, threw)
}

{
  const def = TOOLS.find((t) => t.name === 'set_expected_duration')
  ok('tool is registered in TOOLS with a minutes schema', def?.inputSchema?.required?.includes('minutes'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
