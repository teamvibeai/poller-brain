// Unit tests for the list_channels / search_users tool handlers
// (poller-brain#448 — Slack MCP toolset was missing channel/user discovery,
// forcing agents to already know a channel/user ID before they could
// read_channel/send_message or tag someone).
//
// list_channels wraps conversations.list, filtered client-side to
// is_member !== false (Slack has no server-side "channels this bot belongs
// to" filter; im/mpim conversations don't reliably carry is_member at all,
// so only an explicit false — a public/private channel the bot hasn't been
// invited to — is excluded).
//
// search_users wraps users.list + a client-side substring filter, since
// Slack's Web API has no users.search endpoint. Necessarily workspace-wide
// (unlike list_channels), because Slack has no "users visible to a bot"
// concept.
//
// slack.mjs auto-starts a stdio server on import, so we load just the pure
// prelude (everything before the transport section) and export-by-eval
// handleTool + TOOLS, same trick as slack-expected-duration.test.mjs. Network
// calls go through the real slackApi() with global.fetch mocked, same trick
// as slack-payload.test.mjs (l).
// Run: node mcp/__tests__/slack-discovery.test.mjs
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

// Mocks global.fetch to serve one or more canned Slack API JSON responses in
// order (one per call), and records the request bodies it was given so tests
// can assert on what was actually sent. Restores the real fetch on return.
async function withMockedResponses(responses, fn) {
  const realFetch = globalThis.fetch
  const calls = []
  let i = 0
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return { json: async () => r }
  }
  try {
    return { result: await fn(), calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

// --- TOOLS registration ---
{
  const lc = TOOLS.find((t) => t.name === 'list_channels')
  const su = TOOLS.find((t) => t.name === 'search_users')
  ok('list_channels registered', !!lc)
  ok('search_users registered', !!su)
  ok('search_users requires query', su.inputSchema.required?.includes('query'))
  ok('list_channels has no required fields (all optional)', !lc.inputSchema.required)
}

// --- list_channels ---

// 1) filters to is_member !== false, keeps im/mpim without the field at all,
//    maps expected shape, drops is_member from output
{
  const page = {
    ok: true,
    channels: [
      { id: 'C1', name: 'general', is_member: true, is_private: false, num_members: 10 },
      { id: 'C2', name: 'secret', is_member: false, is_private: true }, // not invited → excluded
      { id: 'C3', name: 'invited-private', is_member: true, is_private: true, num_members: 3 },
      { id: 'D1', is_im: true, user: 'U9' }, // im: no is_member field at all → kept
      { id: 'G1', is_mpim: true, name: 'mpim-thread', is_member: true },
    ],
  }
  const { result } = await withMockedResponses([page], () => handleTool('list_channels', {}))
  ok('1 ok true', result.ok === true)
  ok('1 excludes explicit is_member:false', !result.channels.some((c) => c.id === 'C2'))
  ok('1 keeps im with no is_member field', result.channels.some((c) => c.id === 'D1'))
  ok('1 returns 4 channels', result.channels.length === 4)
  const general = result.channels.find((c) => c.id === 'C1')
  ok('1 shape: id/name/is_private/is_im/is_mpim/num_members',
    general.id === 'C1' && general.name === 'general' && general.is_private === false &&
    general.is_im === false && general.is_mpim === false && general.num_members === 10)
  const dm = result.channels.find((c) => c.id === 'D1')
  ok('1 im without a name falls back to dm:<user>', dm.name === 'dm:U9')
}

// 2) default types param sent to conversations.list
{
  const { calls } = await withMockedResponses([{ ok: true, channels: [] }], () => handleTool('list_channels', {}))
  const body = new URLSearchParams(calls[0].body)
  ok('2 default types = public_channel,private_channel,mpim,im', body.get('types') === 'public_channel,private_channel,mpim,im')
  ok('2 exclude_archived sent', body.get('exclude_archived') === 'true')
}

// 3) custom types param passed through verbatim
{
  const { calls } = await withMockedResponses([{ ok: true, channels: [] }], () => handleTool('list_channels', { types: 'public_channel' }))
  const body = new URLSearchParams(calls[0].body)
  ok('3 custom types forwarded', body.get('types') === 'public_channel')
}

// 4) pagination: follows cursor across pages, stops once collected >= limit
{
  const page1 = {
    ok: true,
    channels: [{ id: 'C1', name: 'a', is_member: true }, { id: 'C2', name: 'b', is_member: true }],
    response_metadata: { next_cursor: 'cursor2' },
  }
  const page2 = {
    ok: true,
    channels: [{ id: 'C3', name: 'c', is_member: true }],
    response_metadata: { next_cursor: '' },
  }
  const { result, calls } = await withMockedResponses([page1, page2], () => handleTool('list_channels', {}))
  ok('4 two pages fetched', calls.length === 2)
  ok('4 second page used the cursor', new URLSearchParams(calls[1].body).get('cursor') === 'cursor2')
  ok('4 results concatenated across pages', result.channels.length === 3)
}

// 5) limit truncates and stops paging once satisfied
{
  const page1 = {
    ok: true,
    channels: [{ id: 'C1', is_member: true }, { id: 'C2', is_member: true }],
    response_metadata: { next_cursor: 'cursor2' },
  }
  const { result, calls } = await withMockedResponses([page1, { ok: true, channels: [] }], () =>
    handleTool('list_channels', { limit: 1 }),
  )
  ok('5 truncates to requested limit', result.channels.length === 1)
  ok('5 does not fetch a second page once limit is met', calls.length === 1)
}

// 5b) limit: 0 and negative limits must throw, not silently fall back to the
//     default (poller-brain#449 review: `Number(args.limit) || 200` treated 0
//     as falsy and any negative number as a valid-but-nonsensical limit)
{
  for (const bad of [0, -1, -200, NaN, 'not-a-number']) {
    let threw = false
    try {
      await handleTool('list_channels', { limit: bad })
    } catch {
      threw = true
    }
    ok(`5b list_channels limit=${bad} throws`, threw)
  }
}

// --- search_users ---

// 6) empty/missing query throws
{
  let threw = false
  try {
    await handleTool('search_users', {})
  } catch {
    threw = true
  }
  ok('6a missing query throws', threw)
  threw = false
  try {
    await handleTool('search_users', { query: '   ' })
  } catch {
    threw = true
  }
  ok('6b blank query throws', threw)
}

// 7) case-insensitive substring match across name fields, deleted users dropped,
//    bots kept
{
  const page = {
    ok: true,
    members: [
      { id: 'U1', name: 'jnovak', deleted: false, real_name: 'Jan Novák', profile: { display_name: 'Jan N.', email: 'jan@example.com' } },
      { id: 'U2', name: 'jsmith', deleted: false, real_name: 'John Smith', profile: {} },
      { id: 'U3', name: 'gone', deleted: true, real_name: 'Jan Deleted', profile: {} }, // deleted → excluded even though it matches
      { id: 'B1', name: 'jarvis-bot', deleted: false, is_bot: true, real_name: 'J.A.R.V.I.S.', profile: {} },
    ],
  }
  const { result } = await withMockedResponses([page], () => handleTool('search_users', { query: 'jan' }))
  const ids = result.users.map((u) => u.id)
  ok('7 matches real_name substring case-insensitively', ids.includes('U1'))
  ok('7 excludes deleted user even though it matches', !ids.includes('U3'))
  ok('7 does not match unrelated user', !ids.includes('U2'))
  ok('7 bots are not excluded by default', TOOLS.find((t) => t.name === 'search_users').description.includes('workspace'))
  const jan = result.users.find((u) => u.id === 'U1')
  ok('7 shape: id/name/display_name/real_name/email/is_bot',
    jan.id === 'U1' && jan.name === 'jnovak' && jan.display_name === 'Jan N.' &&
    jan.real_name === 'Jan Novák' && jan.email === 'jan@example.com' && jan.is_bot === false)
}

// 8) matches on email too
{
  const page = { ok: true, members: [{ id: 'U5', name: 'x', deleted: false, real_name: 'X Y', profile: { email: 'findme@corp.com' } }] }
  const { result } = await withMockedResponses([page], () => handleTool('search_users', { query: 'findme' }))
  ok('8 matches email substring', result.users.length === 1 && result.users[0].id === 'U5')
}

// 9) pagination across users.list pages, stops once limit satisfied
{
  const page1 = {
    ok: true,
    members: [{ id: 'U1', name: 'match1', deleted: false, real_name: 'Match One', profile: {} }],
    response_metadata: { next_cursor: 'c2' },
  }
  const page2 = {
    ok: true,
    members: [{ id: 'U2', name: 'match2', deleted: false, real_name: 'Match Two', profile: {} }],
    response_metadata: { next_cursor: '' },
  }
  const { result, calls } = await withMockedResponses([page1, page2], () => handleTool('search_users', { query: 'match' }))
  ok('9 paginates across users.list', calls.length === 2)
  ok('9 collects matches from both pages', result.users.length === 2)
}

// 10) bots ARE kept (matches by name) — explicit assertion beyond the description check in (7)
{
  const page = { ok: true, members: [{ id: 'B2', name: 'helper-bot', deleted: false, is_bot: true, real_name: 'Helper Bot', profile: {} }] }
  const { result } = await withMockedResponses([page], () => handleTool('search_users', { query: 'helper' }))
  ok('10 bot user returned with is_bot true', result.users.length === 1 && result.users[0].is_bot === true)
}

// 11) limit: 0 and negative limits must throw, not silently fall back to the
//     default (poller-brain#449 review: same falsy-zero bug as list_channels)
{
  for (const bad of [0, -1, -20, NaN, 'not-a-number']) {
    let threw = false
    try {
      await handleTool('search_users', { query: 'x', limit: bad })
    } catch {
      threw = true
    }
    ok(`11 search_users limit=${bad} throws`, threw)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
