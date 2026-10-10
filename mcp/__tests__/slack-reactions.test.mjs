// Unit tests for the list_reactions tool and the reactions enrichment on
// read_thread/read_channel (poller-brain#518/#520 — feedback: no way to see
// what emoji reactions already exist on a message short of guessing or
// probing via add_reaction side effects).
//
// list_reactions wraps reactions.get (form-encoded — not in JSON_SAFE_METHODS,
// and not live-probed for JSON safety since the bot token currently lacks the
// reactions:read scope this method needs; see the code comment above the
// case handler). read_thread/read_channel get a `reactions` field for free
// from conversations.replies/history once that scope is granted — no extra
// API call.
//
// slack.mjs auto-starts a stdio server on import, so we load just the pure
// prelude (everything before the transport section) and export-by-eval
// handleTool + TOOLS, same trick as slack-discovery.test.mjs. Network calls
// go through the real slackApi() with global.fetch mocked, same trick as
// slack-payload.test.mjs.
// Run: node mcp/__tests__/slack-reactions.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.SLACK_CHANNEL = 'C_DEFAULT'
process.env.SLACK_MESSAGE_TS = '1000.0001'
process.env.SLACK_THREAD_TS = '1000.0001'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'slack.mjs'), 'utf8')
const prelude = src.split('// --- stdio transport ---')[0]
const exports = '\nexport { handleTool, TOOLS }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { handleTool, TOOLS } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

async function withMockedResponse(response, fn) {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body })
    return { json: async () => response }
  }
  try {
    return { result: await fn(), calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

// --- TOOLS registration ---
{
  const t = TOOLS.find((x) => x.name === 'list_reactions')
  ok('list_reactions registered', !!t)
  ok('list_reactions has no required fields (both default from env)', !t.inputSchema.required)
}

// --- list_reactions ---

// 1) message target: maps name/count/users, form-encodes the request
{
  const resp = {
    ok: true,
    type: 'message',
    message: {
      reactions: [
        { name: 'thumbsup', count: 2, users: ['U1', 'U2'] },
        { name: 'eyes', count: 1, users: ['U3'] },
      ],
    },
  }
  const { result, calls } = await withMockedResponse(resp, () =>
    handleTool('list_reactions', { channel: 'C1', timestamp: '123.456' }),
  )
  ok('1 ok true', result.ok === true)
  ok('1 returns both reactions', result.reactions.length === 2)
  ok('1 shape: name/count/users', result.reactions[0].name === 'thumbsup' && result.reactions[0].count === 2 && result.reactions[0].users.includes('U1'))
  ok('1 hit reactions.get', calls[0].url.includes('reactions.get'))
  ok('1 form-encoded body (not JSON)', !calls[0].body.trim().startsWith('{'))
  const body = new URLSearchParams(calls[0].body)
  ok('1 channel/timestamp forwarded', body.get('channel') === 'C1' && body.get('timestamp') === '123.456')
}

// 2) file target: falls back to result.file.reactions
{
  const resp = { ok: true, type: 'file', file: { reactions: [{ name: 'tada', count: 1, users: ['U9'] }] } }
  const { result } = await withMockedResponse(resp, () => handleTool('list_reactions', { channel: 'C1', timestamp: '123.456' }))
  ok('2 reads file.reactions', result.reactions.length === 1 && result.reactions[0].name === 'tada')
}

// 3) no reactions on the target → empty array, not an error
{
  const resp = { ok: true, type: 'message', message: {} }
  const { result } = await withMockedResponse(resp, () => handleTool('list_reactions', { channel: 'C1', timestamp: '123.456' }))
  ok('3 empty array when no reactions field', Array.isArray(result.reactions) && result.reactions.length === 0)
}

// 4) channel/timestamp default from env when omitted
{
  const resp = { ok: true, type: 'message', message: { reactions: [] } }
  const { calls } = await withMockedResponse(resp, () => handleTool('list_reactions', {}))
  const body = new URLSearchParams(calls[0].body)
  ok('4 channel defaults from SLACK_CHANNEL', body.get('channel') === 'C_DEFAULT')
  ok('4 timestamp defaults from SLACK_MESSAGE_TS', body.get('timestamp') === '1000.0001')
}

// --- read_thread / read_channel reactions enrichment ---

// 5) read_thread: reactions field present only on messages that have them
{
  const resp = {
    ok: true,
    messages: [
      { user: 'U1', text: 'hi', ts: '1.1', reactions: [{ name: 'eyes', count: 1, users: ['U2'] }] },
      { user: 'U2', text: 'bye', ts: '1.2' },
    ],
  }
  const { result } = await withMockedResponse(resp, () => handleTool('read_thread', { channel: 'C1', thread_ts: '1.1' }))
  const [withReaction, withoutReaction] = result.messages
  ok('5 message with reactions gets a reactions array', Array.isArray(withReaction.reactions) && withReaction.reactions[0].name === 'eyes')
  ok('5 message without reactions omits the key entirely', !('reactions' in withoutReaction))
}

// 6) read_channel: same enrichment
{
  const resp = {
    ok: true,
    messages: [{ user: 'U1', text: 'hi', ts: '1.1', reactions: [{ name: 'tada', count: 3, users: ['U1', 'U2', 'U3'] }] }],
  }
  const { result } = await withMockedResponse(resp, () => handleTool('read_channel', { channel: 'C1' }))
  ok('6 read_channel message carries reactions array', result.messages[0].reactions.length === 1 && result.messages[0].reactions[0].count === 3)
}

// 7) read_thread/read_channel: missing `users` on a reaction object defaults to
// [] instead of the key silently dropping — uniform shape with list_reactions
// (DevGuru review on PR #521)
{
  const resp = { ok: true, messages: [{ user: 'U1', text: 'hi', ts: '1.1', reactions: [{ name: 'eyes', count: 1 }] }] }
  const { result: viaThread } = await withMockedResponse(resp, () => handleTool('read_thread', { channel: 'C1', thread_ts: '1.1' }))
  ok('7a read_thread defaults missing users to []', Array.isArray(viaThread.messages[0].reactions[0].users) && viaThread.messages[0].reactions[0].users.length === 0)
  const { result: viaChannel } = await withMockedResponse(resp, () => handleTool('read_channel', { channel: 'C1' }))
  ok('7b read_channel defaults missing users to []', Array.isArray(viaChannel.messages[0].reactions[0].users) && viaChannel.messages[0].reactions[0].users.length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
