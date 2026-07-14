// Unit tests for buildSendPayload() — the pure send_message branch logic
// (tv.ai#228 follow-up #4). Locks the three-way decision regressibly:
//   (a) auto-convert  — pipe-table in `text` AND no agent blocks
//   (b) section-prepend — `text` + agent blocks (or modals)
//   (c) verbatim passthrough — plain `text`, no blocks
// slack.mjs auto-starts a stdio server on import, so we load just the pure
// prelude (everything before the transport section) and export-by-eval the
// helper. No network, no Slack. Run: node mcp/__tests__/slack-payload.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'slack.mjs'), 'utf8')
const prelude = src.split('// --- stdio transport ---')[0]
const exports = '\nexport { buildSendPayload }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { buildSendPayload } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

const TABLE = '| úkol | stav |\n|---|---|\n| deploy | ✅ |'

// (a) auto-convert branch: pipe-table in text, no agent blocks
{
  const r = buildSendPayload({ text: `Hotovo:\n\n${TABLE}` })
  ok('a transformed echo present', r.transformed?.reason === 'pipe_table_in_text')
  ok('a exactly one markdown block', r.blocks.filter(b => b.type === 'markdown').length === 1)
  ok('a effectiveText = native fallback (no pipes)', !r.effectiveText.includes('|'))
  // raw tableWarning still returned — the caller suppresses it because transformed is set
  ok('a raw tableWarning returned for caller to suppress', !!r.tableWarning)
  ok('a agentSuppliedBlocks false', r.agentSuppliedBlocks === false)
}

// (b) opt-out passthrough: agent supplied its own blocks + a table in text
{
  const own = [{ type: 'section', text: { type: 'mrkdwn', text: 'mine' } }]
  const r = buildSendPayload({ text: `Hotovo:\n\n${TABLE}`, blocks: own })
  ok('b NOT converted (opt-out)', r.transformed === null)
  ok('b tableWarning kept (table left in text)', !!r.tableWarning)
  ok('b effectiveText unchanged verbatim', r.effectiveText === `Hotovo:\n\n${TABLE}`)
  // text is section-prepended ahead of the agent's own blocks
  ok('b sections prepended before own blocks', r.blocks[r.blocks.length - 1] === own[0] && r.blocks[0].type === 'section')
  ok('b agentSuppliedBlocks true', r.agentSuppliedBlocks === true)
}

// (b') section-prepend with blocks but no table in text
{
  const own = [{ type: 'divider' }]
  const r = buildSendPayload({ text: 'plain prose', blocks: own })
  ok("b' no transform, no table warning", r.transformed === null && !r.tableWarning)
  ok("b' prose section prepended, divider kept last", r.blocks[0].type === 'section' && r.blocks[r.blocks.length - 1].type === 'divider')
}

// (b'') modals present, no agent blocks, no table → text still section-prepended
{
  const r = buildSendPayload({ text: 'open the form' }, { hasModals: true })
  ok("b'' modal path prepends text sections", r.blocks.length > 0 && r.blocks.every(b => b.type === 'section'))
  ok("b'' no transform", r.transformed === null)
}

// (c) verbatim passthrough: plain text, no blocks, no modals → NO blocks added
{
  const r = buildSendPayload({ text: 'just a normal message' })
  ok('c no blocks synthesized', r.blocks.length === 0)
  ok('c effectiveText verbatim', r.effectiveText === 'just a normal message')
  ok('c no transform, no table warning', r.transformed === null && !r.tableWarning)
}

// (d) edge: empty / whitespace-only text must not throw or convert
{
  const r1 = buildSendPayload({ text: '   ' })
  const r2 = buildSendPayload({})
  ok('d whitespace text → no blocks, no transform', r1.blocks.length === 0 && r1.transformed === null)
  ok('d missing text → no crash, no blocks', r2.blocks.length === 0 && r2.transformed === null)
}

// (e) fleet-safety invariant: agent that already sends blocks+text is never auto-converted,
// even when the text contains a table (the exact regression #206 guarded against)
{
  const own = [{ type: 'markdown', text: TABLE }]
  const r = buildSendPayload({ text: TABLE, blocks: own })
  ok('e agent blocks+table text → passthrough (no double render path)', r.transformed === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
