// Exercise the real MCP boundary and form transport with mocked Slack pages.
// Run: node mcp/__tests__/slack-read-thread.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(mcpDir, 'slack.mjs'), 'utf8')
  .split('// --- stdio transport ---')[0]
  .replace(/'\.\/lib\/([^']+)'/g, (_, file) => JSON.stringify(pathToFileURL(join(mcpDir, 'lib', file)).href))
const THREAD_TS = '1790081797.452189'
const RECEIPT_TS = '1790081800.000001'
const CURSOR = 'bmV4dDo+/=:_-'
let instance = 0

async function fixture(pages, run) {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  Object.assign(process.env, {
    SLACK_BOT_TOKEN: 'xoxb-mock', SLACK_CHANNEL: 'CDEFAULT', SLACK_THREAD_TS: THREAD_TS,
  })
  const calls = []
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://slack.com/api/conversations.replies')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded')
    const page = pages[calls.length]
    calls.push(Object.fromEntries(new URLSearchParams(options.body)))
    assert.ok(page, 'each tool call must issue only one expected request')
    if (page instanceof Error) throw page
    return { ok: true, json: async () => page }
  }
  try {
    const { handleRequest } = await import('data:text/javascript,' + encodeURIComponent(source + '\nexport { handleRequest }\n') + `#${instance++}`)
    const call = async (args) => {
      const response = JSON.parse(await handleRequest({
        jsonrpc: '2.0', id: 499, method: 'tools/call',
        params: { name: 'read_thread', arguments: args },
      }))
      assert.equal(response.id, 499)
      assert.ok(!response.error, 'failures must be MCP tool errors, not RPC errors')
      return { envelope: response.result, result: JSON.parse(response.result.content[0].text) }
    }
    await run({ call, calls })
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  }
}

test('a receipt absent on page one is found by round-tripping the cursor and destination', () => fixture([
  {
    ok: true, messages: [{ user: 'U1', text: 'parent', ts: THREAD_TS }],
    has_more: true, response_metadata: { next_cursor: CURSOR },
  },
  {
    ok: true, messages: [{ bot_id: 'B1', text: 'published receipt', ts: RECEIPT_TS }],
    has_more: false, response_metadata: { next_cursor: '' },
  },
], async ({ call, calls }) => {
  const first = await call({ channel: 'CTARGET', thread_ts: THREAD_TS, limit: 1 })
  assert.ok(!first.envelope.isError)
  assert.equal(first.result.has_more, true)
  assert.equal(first.result.next_cursor, CURSOR)
  assert.equal(first.result.channel, 'CTARGET')
  assert.equal(first.result.thread_ts, THREAD_TS)
  assert.ok(!first.result.messages.some(m => m.ts === RECEIPT_TS))
  assert.deepEqual(calls, [{ channel: 'CTARGET', ts: THREAD_TS, limit: '1' }], 'no automatic traversal')

  const second = await call({
    channel: first.result.channel, thread_ts: first.result.thread_ts,
    cursor: first.result.next_cursor, limit: 1,
  })
  assert.ok(!second.envelope.isError)
  assert.equal(second.result.messages[0].ts, RECEIPT_TS)
  assert.equal(second.result.has_more, false)
  assert.ok(!Object.hasOwn(second.result, 'next_cursor'))
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { channel: 'CTARGET', ts: THREAD_TS, limit: '1', cursor: CURSOR })
}))

test('legacy callers retain the default request, message fields and Slack ordering', () => fixture([
  { ok: true, messages: [
    { user: 'U1', text: 'parent', ts: THREAD_TS },
    {
      bot_id: 'B1', ts: RECEIPT_TS,
      reactions: [{ name: 'eyes', count: 1 }],
      blocks: [{ type: 'divider' }], attachments: [{ text: 'attachment' }],
      files: [{ name: 'receipt.txt', mimetype: 'text/plain', url_private: 'https://files.invalid/receipt', size: 7 }],
    },
    { ts: '1790081801.000001', blocks: [], attachments: [], files: [], reactions: [] },
  ] },
], async ({ call, calls }) => {
  const { result, envelope } = await call(undefined)
  assert.ok(!envelope.isError)
  assert.deepEqual(calls, [{ channel: 'CDEFAULT', ts: THREAD_TS, limit: '20' }])
  assert.deepEqual(result, {
    ok: true,
    messages: [
      { user: 'U1', text: 'parent', ts: THREAD_TS, is_bot: false },
      {
        user: 'B1', text: '', ts: RECEIPT_TS, is_bot: true,
        reactions: [{ name: 'eyes', count: 1, users: [] }],
        blocks: [{ type: 'divider' }], attachments: [{ text: 'attachment' }],
        files: [{ name: 'receipt.txt', mimetype: 'text/plain', url: 'https://files.invalid/receipt', size: 7 }],
      },
      { user: 'unknown', text: '', ts: '1790081801.000001', is_bot: false },
    ],
    channel: 'CDEFAULT', thread_ts: THREAD_TS, has_more: false,
  })
}))

for (const inclusive of [undefined, true, false]) {
  test(`bounds and inclusive=${inclusive} survive cursor continuation as exact strings`, () => fixture([
    { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: CURSOR } },
    { ok: true, messages: [], has_more: false },
  ], async ({ call, calls }) => {
    const args = { oldest: THREAD_TS, latest: '1790081899.999999', ...(inclusive !== undefined && { inclusive }) }
    const first = await call(args)
    const second = await call({ ...args, cursor: first.result.next_cursor })
    assert.ok(!first.envelope.isError && !second.envelope.isError)
    const body = {
      channel: 'CDEFAULT', ts: THREAD_TS, limit: '20',
      oldest: args.oldest, latest: args.latest,
      ...(inclusive !== undefined && { inclusive: String(inclusive) }),
    }
    assert.deepEqual(calls, [body, { ...body, cursor: CURSOR }])
  }))
}

for (const metadata of [
  { has_more: true },
  { response_metadata: { next_cursor: CURSOR } },
  { has_more: false, response_metadata: { next_cursor: CURSOR } },
]) {
  test(`empty page preserves evidence of incompleteness: ${JSON.stringify(metadata)}`, () => fixture([
    { ok: true, messages: [], ...metadata },
  ], async ({ call, calls }) => {
    const { result } = await call({})
    assert.deepEqual(result.messages, [])
    assert.equal(result.has_more, true)
    assert.equal(result.next_cursor, metadata.response_metadata?.next_cursor)
    assert.equal(calls.length, 1)
  }))
}

for (const failure of [
  { ok: false, error: 'invalid_cursor' },
  { ok: false, error: 'ratelimited' },
  { ok: false, error: 'not_in_channel' },
  new Error('mock transport failure'),
]) {
  test(`continuation failure is a tool error: ${failure.error || failure.message}`, () => fixture([
    { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: CURSOR } },
    failure,
  ], async ({ call, calls }) => {
    const first = await call({})
    const { result, envelope } = await call({ cursor: first.result.next_cursor })
    assert.equal(envelope.isError, true)
    assert.deepEqual(result, {
      ok: false,
      error: failure instanceof Error ? failure.message : `Slack API conversations.replies: ${failure.error}`,
    })
    assert.equal(calls.length, 2)
  }))
}

for (const value of [null, 12, {}, [], '', ' ', ' cursor', 'cur sor', 'cursor\n', 'cursor\r', 'cursor\0', 'cursor\x7f']) {
  test(`reject invalid cursor ${JSON.stringify(value)} before fetch`, () => fixture([], async ({ call, calls }) => {
    const { result, envelope } = await call({ cursor: value })
    assert.equal(envelope.isError, true)
    assert.equal(result.ok, false)
    assert.match(result.error, /parameter `cursor`/)
    assert.deepEqual(calls, [])
  }))
}

for (const field of ['thread_ts', 'oldest', 'latest']) {
  for (const value of [null, 1790081797.452189, '', 'no-ts', '-1.000001', '1', '1e3.1', '1.1234567', '1234567890123.1', '1.1\n', ' 1.1']) {
    test(`reject invalid ${field} ${JSON.stringify(value)} before fetch`, () => fixture([], async ({ call, calls }) => {
      const { result, envelope } = await call({ [field]: value })
      assert.equal(envelope.isError, true)
      assert.equal(result.ok, false)
      assert.ok(result.error.includes(`parameter \`${field}\``))
      assert.deepEqual(calls, [])
    }))
  }
}

for (const value of [null, 'true', 1]) {
  test(`reject nonboolean inclusive ${JSON.stringify(value)}`, () => fixture([], async ({ call, calls }) => {
    const { result, envelope } = await call({ inclusive: value })
    assert.equal(envelope.isError, true)
    assert.match(result.error, /parameter `inclusive`/)
    assert.deepEqual(calls, [])
  }))
}
