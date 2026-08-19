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
const exports = '\nexport { buildSendPayload, buildSendResponse, needsFormEncoding, slackApi }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { buildSendPayload, buildSendResponse, needsFormEncoding, slackApi } = mod

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

// (g) poller-brain#225: bold-wrapped bare URL in text -> stripped + echoed,
// applies even when no table is present (the plain-passthrough case the bug
// actually reproduces in)
{
  const r = buildSendPayload({ text: 'Report: *https://x.io/a* hotovo' })
  ok('g effectiveText has asterisks stripped', r.effectiveText === 'Report: https://x.io/a hotovo')
  ok('g no blocks synthesized (still plain passthrough)', r.blocks.length === 0)
  ok('g transformed echoes the fix', r.transformed?.reason === 'bold_wrapped_url_in_text' && r.transformed.bold_url_stripped === true)
}

// (h) #225 fix still applies even when the agent supplies its own blocks —
// `text` still reaches Slack (section-prepended), so the same bug would hit it
{
  const own = [{ type: 'divider' }]
  const r = buildSendPayload({ text: '*https://x.io/a*', blocks: own })
  ok('h text field fixed even with agent blocks', r.blocks[0].type === 'section' && r.blocks[0].text.text === 'https://x.io/a')
  ok('h transform still echoed', r.transformed?.bold_url_stripped === true)
}

// (i) #225 + table combo: both fixes apply, table transform stays primary reason
{
  const r = buildSendPayload({ text: `*https://x.io/a*\n\n${TABLE}` })
  ok('i table transform reason preserved', r.transformed?.reason === 'pipe_table_in_text')
  ok('i bold_url_stripped flag also present', r.transformed?.bold_url_stripped === true)
  ok('i prose section carries the stripped URL, no asterisks', r.blocks.find(b => b.type === 'section').text.text.includes('https://x.io/a') && !r.blocks.find(b => b.type === 'section').text.text.includes('*https'))
}

// (f) buildSendResponse key order — the poller truncates a logged tool_result at
// 200 chars, so a code that lands after unbounded prose is invisible to whoever
// counts warnings in the session log (#108 counting, #184 phase 3).
{
  const truncate = (s) => (s.length > 200 ? s.slice(0, 200) + '...' : s) // claude-spawner.ts truncateOutput
  const warn = { code: 'missing_recipient_tag', detail: 'x'.repeat(300), last_speaker_id: 'U1' }
  const transformed = {
    reason: 'pipe_table_in_text',
    table_moved_to: 'markdown_block',
    fallback_text: 'Prehled dnesnich PR a jejich stavu, tabulka nize shrnuje co ceka na merge a co je zavrene.',
  }
  const r = buildSendResponse({ ts: '1.1', transformed, warnings: [warn] })
  const keys = Object.keys(r)
  ok('f warning_codes precedes transformed', keys.indexOf('warning_codes') < keys.indexOf('transformed'))
  ok('f code survives truncation despite long fallback_text', truncate(JSON.stringify(r)).includes('missing_recipient_tag'))
  ok('f full warnings still returned to the agent', r.warnings.length === 1 && r.warnings[0].detail.length === 300)

  const clean = buildSendResponse({ ts: '1.1', transformed: null, warnings: [null, null] })
  ok('f no warnings → no warning_codes key', !('warning_codes' in clean) && !('warnings' in clean))
  ok('f clean response is unchanged shape', JSON.stringify(clean) === '{"ok":true,"ts":"1.1"}')

  const two = buildSendResponse({ ts: '1.1', transformed: null, warnings: [warn, { code: 'thread_ts_override_unjustified', detail: 'y'.repeat(450) }] })
  ok('f both codes survive truncation together', truncate(JSON.stringify(two)).includes('thread_ts_override_unjustified'))
}

// (j) HTML-entity normalization (poller-brain#243): escaped mention/link
// syntax is unescaped before any table/block processing sees it, in every
// branch (verbatim passthrough, section-prepend, and inside a synthesized
// table's surrounding prose).
{
  const r = buildSendPayload({ text: 'ping &lt;@U02C5FJFD6E&gt; re: A &amp; B' })
  ok('j verbatim passthrough unescaped', r.effectiveText === 'ping <@U02C5FJFD6E> re: A & B')
}
{
  const own = [{ type: 'divider' }]
  const r = buildSendPayload({ text: 'hi &lt;@U1&gt;', blocks: own })
  ok('j section-prepend branch unescaped', r.blocks[0].text.text === 'hi <@U1>')
}
{
  // &amp;lt; must decode to literal "&lt;", not cascade into "<"
  const r = buildSendPayload({ text: 'literal &amp;lt; stays escaped-once' })
  ok('j &amp; decoded last (no cascade)', r.effectiveText === 'literal &lt; stays escaped-once')
}
{
  // table-auto-convert branch: prose surrounding the table carries the
  // escaped mention — must be unescaped in the actual `blocks` sent to
  // Slack (not just effectiveText/fallbackText), since blocks is what
  // renders once present (DevGuru review, poller-brain#243).
  const r = buildSendPayload({ text: `ping &lt;@U1&gt; hotovo:\n\n${TABLE}` })
  const proseBlock = r.blocks.find(b => b.type === 'section')
  ok('j table-branch prose block unescaped', proseBlock?.text?.text === 'ping <@U1> hotovo:')
  ok('j table-branch fallbackText unescaped', r.effectiveText.includes('ping <@U1> hotovo:'))
}
{
  // a QUOTED escaped mention inside a fenced code block (a bug report citing
  // the raw syntax, exactly like this review thread) must stay literal —
  // decoding it would turn a code example into a real ping (DevGuru review,
  // poller-brain#243).
  const r = buildSendPayload({ text: 'see example:\n```\nping &lt;@U1&gt;\n```\nreal ping: &lt;@U2&gt;' })
  ok('j fenced code block left escaped', r.effectiveText.includes('```\nping &lt;@U1&gt;\n```'))
  ok('j prose outside fence still unescaped', r.effectiveText.includes('real ping: <@U2>'))
}
{
  // same for a single-backtick inline code span
  const r = buildSendPayload({ text: 'the literal `&lt;@U1&gt;` syntax vs a real ping &lt;@U2&gt;' })
  ok('j inline code span left escaped', r.effectiveText.includes('`&lt;@U1&gt;`'))
  ok('j prose outside inline code still unescaped', r.effectiveText.includes('a real ping <@U2>'))
}

// (k) poller-brain#345: every method actually called via slackApi() in this file (from
// `grep -n "slackApi('" slack.mjs`, kept in sync manually) gets the encoding Slack's live
// API actually requires for it — not just the two named in the original ticket. DevGuru's
// live probe (2026-08-19) additionally caught pins.list failing the same way as
// chat.getPermalink; the pre-fix test suite passed 169/169 while pins.list was broken,
// because the old asserts only named the ticket's one method instead of every call site.
{
  const formEncoded = ['conversations.info', 'conversations.replies', 'conversations.history', 'conversations.setTopic', 'conversations.setPurpose', 'files.getUploadURLExternal', 'files.completeUploadExternal', 'chat.getPermalink', 'pins.list']
  const jsonEncoded = ['auth.test', 'users.info', 'chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove', 'bookmarks.list', 'assistant.threads.setStatus']
  for (const m of formEncoded) ok(`k ${m} form-encoded`, needsFormEncoding(m))
  for (const m of jsonEncoded) ok(`k ${m} JSON-encoded`, !needsFormEncoding(m))
}

// (l) poller-brain#345 nit: prove slackApi() actually consults the predicate (not just
// that the diff currently wires it in) — mock fetch, call the real slackApi(), and read
// back the Content-Type/body shape it sent. Would catch a future regression where the
// condition is inlined again and silently drifts from needsFormEncoding.
{
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body })
    return { json: async () => ({ ok: true }) }
  }
  await slackApi('chat.getPermalink', { channel: 'C1', message_ts: '1.1' })
  await slackApi('chat.postMessage', { channel: 'C1', text: 'hi' })
  globalThis.fetch = realFetch

  ok('l form method sends x-www-form-urlencoded', calls[0].headers['Content-Type'] === 'application/x-www-form-urlencoded')
  ok('l form method body is urlencoded, not JSON', calls[0].body === 'channel=C1&message_ts=1.1')
  ok('l json method sends application/json', calls[1].headers['Content-Type'] === 'application/json')
  ok('l json method body is a JSON string', calls[1].body === JSON.stringify({ channel: 'C1', text: 'hi' }))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
