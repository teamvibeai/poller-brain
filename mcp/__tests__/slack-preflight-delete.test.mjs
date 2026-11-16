// Mocked MCP boundary tests: no Slack or platform writes leave this process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(mcpDir, 'slack.mjs'), 'utf8')
  .split('// --- stdio transport ---')[0]
  .replace(/'\.\/lib\/([^']+)'/g, (_, file) => JSON.stringify(pathToFileURL(join(mcpDir, 'lib', file)).href))
let instance = 0
const TS = '1000.000002'
const OWN = { ts: TS, user: 'UOWN', bot_id: 'BOWN' }

function assertDeleteAudit(result, outcome, { authenticated = true } = {}) {
  const audit = result.audit_details
  assertCompactDeleteAudit(result)
  assert.ok(audit, 'MCP tool result must carry the deletion audit')
  assert.equal(audit.event, 'slack.delete_message')
  assert.equal(audit.channel, 'CTARGET')
  assert.equal(audit.ts, TS)
  assert.equal(audit.actor_user_id, authenticated ? 'UOWN' : null)
  assert.equal(audit.actor_bot_id, authenticated ? 'BOWN' : null)
  assert.equal(audit.outcome, outcome)
  assert.ok(Number.isFinite(Date.parse(audit.at)))
  assert.equal(audit.reason === null, outcome === 'deleted')
  assert.ok(JSON.stringify(audit).length < 1024, 'audit stays below 1 KiB')
  assert.ok(!JSON.stringify(result).includes('xoxb-mock'))
  assert.deepEqual(Object.keys(audit).sort(), [
    'event', 'channel', 'ts', 'actor_user_id', 'actor_bot_id', 'outcome', 'reason', 'at',
    ...(audit.slack_error ? ['slack_error'] : []),
  ].sort(), 'audit must contain metadata only')
}

function assertCompactDeleteAudit(result) {
  assert.equal(Object.keys(result)[0], 'audit', 'audit must be the first result key')
  assert.equal(typeof result.audit, 'string', 'audit must be a compact string')
  const audit = result.audit_details
  assert.equal(result.audit, [
    'del', audit.outcome, audit.reason, audit.at, audit.channel, audit.ts,
    audit.actor_user_id, audit.actor_bot_id,
  ].map(value => value ?? '-').join('|'))
  assert.ok(
    JSON.stringify(result).slice(0, 200).includes(JSON.stringify(result.audit)),
    'the session log must retain the complete quoted audit string',
  )
  assert.equal(audit.at.length, 24)
  assert.equal(new Date(audit.at).toISOString(), audit.at)
}

async function fixture(run, { env = {}, responses = {} } = {}) {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  Object.assign(process.env, {
    SLACK_BOT_TOKEN: 'xoxb-mock', SLACK_CHANNEL: 'CDEFAULT', SLACK_THREAD_TS: '1000.000001',
    SLACK_MESSAGE_TS: '', TEAMVIBE_API_URL: 'https://platform.invalid',
    TEAMVIBE_POLLER_TOKEN: 'mock', TEAMVIBE_BOT_ID: 'BUNTRUSTED', ...env,
  })
  const calls = []
  globalThis.fetch = async (url, options) => {
    const method = url.split('/').at(-1)
    const body = options.headers['Content-Type'] === 'application/json'
      ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body))
    calls.push({ url, method, body, raw: options.body, headers: options.headers })
    const defaults = {
      'auth.test': { ok: true, user_id: 'UOWN', bot_id: 'BOWN' },
      'conversations.history': { ok: true, messages: [OWN] },
      'conversations.replies': { ok: true, messages: [] },
      'conversations.info': { ok: true, channel: { is_im: true } },
      'chat.postMessage': { ok: true, ts: TS },
      'chat.update': { ok: true, ts: TS },
      'chat.delete': { ok: true, channel: body.channel, ts: body.ts },
      'modal-definitions': { modalDefId: 'M1' },
    }
    const response = Object.hasOwn(responses, method) ? responses[method] : defaults[method]
    if (response instanceof Error) throw response
    assert.ok(response, `unexpected fetch: ${url}`)
    return { ok: true, json: async () => response }
  }
  try {
    const { handleRequest } = await import('data:text/javascript,' + encodeURIComponent(source + '\nexport { handleRequest }\n') + `#${instance++}`)
    const call = async (name, args) => {
      const envelope = JSON.parse(await handleRequest({
        jsonrpc: '2.0', id: 620, method: 'tools/call', params: { name, arguments: args },
      })).result
      return { envelope, result: JSON.parse(envelope.content[0].text) }
    }
    await run({ call, calls })
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  }
}

for (const [label, args, expected] of [
  ['session defaults', {}, { channel: 'CDEFAULT', mode: 'thread', thread_ts: '1000.000001' }],
  ['explicit thread', { channel: 'CTARGET', thread_ts: '2000.000001' }, { channel: 'CTARGET', mode: 'thread', thread_ts: '2000.000001' }],
  ['explicit root', { thread_ts: null }, { channel: 'CDEFAULT', mode: 'root', thread_ts: null }],
]) {
  test(`preflight ${label}: effective destination and zero fetches`, () => fixture(async ({ call, calls }) => {
    const { result, envelope } = await call('send_message', { text: 'hello', ...args, dry_run: true })
    assert.ok(!envelope.isError)
    assert.equal(result.dry_run, true)
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value)
    assert.equal(result.payload.text, 'hello')
    assert.equal(result.payload.thread_ts, expected.thread_ts || undefined)
    assert.deepEqual(calls, [])
  }))
}

test('preflight without session thread is root', () => fixture(async ({ call, calls }) => {
  const { result } = await call('send_message', { text: 'hello', channel: 'CTARGET', dry_run: true })
  assert.equal(result.mode, 'root')
  assert.equal(result.thread_ts, null)
  assert.ok(!Object.hasOwn(result.payload, 'thread_ts'))
  assert.deepEqual(calls, [])
}, { env: { SLACK_THREAD_TS: '', SLACK_CHANNEL: '' } }))

test('preflight missing channel fails without writes', () => fixture(async ({ call, calls }) => {
  const { result, envelope } = await call('send_message', { text: 'hello', dry_run: true })
  assert.equal(envelope.isError, true)
  assert.equal(result.error, 'channel required')
  assert.deepEqual(calls, [])
}, { env: { SLACK_CHANNEL: '' } }))

for (const args of [
  { text: '*https://example.com/a*\n\n| Task | State |\n|---|---|\n| Work | Done |' },
  { text: '*see https://example.com/a*', blocks: [{ type: 'divider' }] },
  { text: 'Open form', modals: [{ label: 'Open', view: { type: 'modal', title: { type: 'plain_text', text: 'Form' }, blocks: [] } }] },
  { text: '*https://example.com/a*', blocks: [{ type: 'divider' }], modals: [{ view: { type: 'modal', title: { type: 'plain_text', text: 'Form' }, blocks: [] } }] },
]) {
  test(`preflight transformed payload matches ordinary initial post: ${JSON.stringify(args).slice(0, 65)}`, () => fixture(async ({ call, calls }) => {
    const { result, envelope } = await call('send_message', { ...args, dry_run: true })
    assert.ok(!envelope.isError)
    assert.deepEqual(calls, [], 'includes no uploads, modal registration, sessions, post or update')
    assert.ok(result.validation.limits)
    assert.ok(result.validation.limitations.length > 0)
    assert.match(JSON.stringify(result.validation.limitations), /Block Kit/)
    const sent = await call('send_message', args)
    const post = calls.find(c => c.method === 'chat.postMessage')
    assert.deepEqual(result.payload, post.body)
    assert.deepEqual(result.transformed, sent.result.transformed)
    if (args.modals) {
      assert.deepEqual(result.modals.definitions, args.modals)
      assert.equal(result.modals.registration, 'deferred')
      assert.ok(calls.some(c => c.method === 'modal-definitions'))
      assert.ok(calls.some(c => c.method === 'chat.update'))
    }
  }))
}

test('preflight sentinel reports suppression without writes', () => fixture(async ({ call, calls }) => {
  const { result } = await call('send_message', { text: 'NO_FURTHER_RESPONSE_NEEDED', dry_run: true })
  assert.equal(result.dry_run, true)
  assert.equal(result.suppressed, 'sentinel')
  assert.equal(result.payload, null)
  assert.deepEqual(calls, [])
}))

test('preflight returns a disabled modal plan without platform credentials or writes', () => fixture(async ({ call, calls }) => {
  const modals = [{ view: { type: 'modal', title: { type: 'plain_text', text: 'Form' }, blocks: [] } }]
  const { result } = await call('send_message', { text: 'hello', thread_ts: null, modals, dry_run: true })
  assert.equal(result.modals.enabled, false)
  assert.equal(result.modals.thread_context, 'sent_message_ts')
  assert.deepEqual(result.modals.definitions, modals)
  assert.ok(!result.payload.blocks)
  assert.deepEqual(calls, [])
}, { env: { TEAMVIBE_API_URL: '', TEAMVIBE_POLLER_TOKEN: '' } }))

test('preflight lists validation limits without claiming Slack validation', () => fixture(async ({ call, calls }) => {
  const { result } = await call('send_message', { text: 'hello', blocks: Array.from({ length: 51 }, () => ({ type: 'divider' })), dry_run: true })
  assert.equal(result.validation.limits.message_blocks, 50)
  assert.match(JSON.stringify(result.validation.limitations), /delivery|succeed/)
  assert.deepEqual(calls, [])
}))

test('dry_run must be boolean; uploads reject unsupported dry_run before API calls', () => fixture(async ({ call, calls }) => {
  for (const [name, args] of [
    ['send_message', { text: 'hello', dry_run: 'true' }],
    ['upload_file', { filepath: '/never-read', dry_run: true }],
    ['upload_snippet', { title: 'x', content: 'x', dry_run: true }],
  ]) {
    assert.equal((await call(name, args)).envelope.isError, true)
  }
  assert.deepEqual(calls, [])
}))

for (const dry_run of [undefined, false]) {
  test(`ordinary thread reply bytes unchanged (dry_run=${dry_run})`, () => fixture(async ({ call, calls }) => {
    const args = { text: 'ordinary reply' }
    if (dry_run !== undefined) args.dry_run = dry_run
    const { result, envelope } = await call('send_message', args)
    assert.ok(!envelope.isError)
    assert.deepEqual(result, { ok: true, ts: TS })
    assert.equal(calls[0].method, 'chat.postMessage')
    assert.equal(calls[0].raw, '{"channel":"CDEFAULT","text":"ordinary reply","unfurl_links":false,"unfurl_media":false,"thread_ts":"1000.000001"}')
  }))
}

for (const message of [OWN, { ts: TS, user: 'UOWN' }, { ts: TS, bot_id: 'BOWN' }]) {
  test(`delete verified own message ${JSON.stringify(message)}`, () => fixture(async ({ call, calls }) => {
    const { result, envelope } = await call('delete_message', { channel: 'CTARGET', ts: TS })
    assert.ok(!envelope.isError)
    assert.equal(result.ok, true)
    assert.equal(result.channel, 'CTARGET')
    assert.equal(result.ts, TS)
    assertDeleteAudit(result, 'deleted')
    assert.deepEqual(calls.map(c => c.method), ['auth.test', 'conversations.history', 'chat.delete'])
    assert.deepEqual(calls[1].body, { channel: 'CTARGET', oldest: TS, latest: TS, inclusive: 'true', limit: '1' })
    assert.deepEqual(calls[2].body, { channel: 'CTARGET', ts: TS })
    assert.equal(calls[2].headers['Content-Type'], 'application/x-www-form-urlencoded')
  }, { responses: { 'conversations.history': { ok: true, messages: [message] } } }))
}

test('delete reply resolves exact message through replies; never deletes parent or other replies', () => fixture(async ({ call, calls }) => {
  const { result } = await call('delete_message', { channel: 'CTARGET', ts: TS })
  assert.equal(result.ok, true)
  const deletes = calls.filter(c => c.method === 'chat.delete')
  assert.deepEqual(deletes.map(c => c.body), [{ channel: 'CTARGET', ts: TS }])
  assert.equal(calls.filter(c => c.method === 'conversations.replies').length, 1)
}, { responses: {
  'conversations.history': { ok: true, messages: [] },
  'conversations.replies': { ok: true, messages: [{ ts: '999.000001', user: 'UOTHER' }, { ...OWN, thread_ts: '999.000001', reply_count: 3 }] },
} }))

for (const [label, message] of [
  ['foreign user', { ts: TS, user: 'UOTHER' }],
  ['foreign bot', { ts: TS, bot_id: 'BOTHER' }],
  ['conflicting bot', { ...OWN, bot_id: 'BOTHER' }],
  ['conflicting user', { ...OWN, user: 'UOTHER' }],
  ['unknown author', { ts: TS }],
  ['environment fallback bot', { ts: TS, bot_id: 'BUNTRUSTED' }],
  ['deleted event', { ...OWN, subtype: 'message_deleted' }],
  ['nested ownership', { ts: TS, message: OWN }],
  ['malformed author', { ...OWN, user: {} }],
]) {
  test(`delete rejects ${label}`, () => fixture(async ({ call, calls }) => {
    const { result, envelope } = await call('delete_message', { channel: 'CTARGET', ts: TS })
    assert.equal(envelope.isError, true)
    assert.ok(['permission_denied', 'ownership_unverified'].includes(result.error))
    assert.ok(!calls.some(c => c.method === 'chat.delete'))
    assertDeleteAudit(result, result.error)
    if (label === 'foreign user') assert.equal(result.audit_details.reason, 'author_mismatch')
  }, { responses: { 'conversations.history': { ok: true, messages: [message] } } }))
}

for (const [label, responses, error] of [
  ['auth failure', { 'auth.test': { ok: false, error: 'invalid_auth' } }, 'permission_denied'],
  ['auth network failure', { 'auth.test': new Error('offline') }, 'ownership_unverified'],
  ['missing auth bot', { 'auth.test': { ok: true, user_id: 'UOWN' } }, 'ownership_unverified'],
  ['missing auth user', { 'auth.test': { ok: true, bot_id: 'BOWN' } }, 'ownership_unverified'],
  ['non-boolean auth success', { 'auth.test': { ok: 'true', user_id: 'UOWN', bot_id: 'BOWN' } }, 'ownership_unverified'],
  ['malformed auth bot', { 'auth.test': { ok: true, user_id: 'UOWN', bot_id: {} } }, 'ownership_unverified'],
  ['history scope failure', { 'conversations.history': { ok: false, error: 'missing_scope' } }, 'permission_denied'],
  ['history network failure', { 'conversations.history': new Error('offline') }, 'ownership_unverified'],
  ['malformed history', { 'conversations.history': { ok: true } }, 'ownership_unverified'],
  ['non-boolean history success', { 'conversations.history': { ok: 'true', messages: [OWN] } }, 'ownership_unverified'],
  ['duplicate exact timestamps', { 'conversations.history': { ok: true, messages: [OWN, OWN] } }, 'ownership_unverified'],
  ['not found', { 'conversations.history': { ok: true, messages: [] } }, 'not_found'],
  ['wrong timestamp', { 'conversations.history': { ok: true, messages: [{ ...OWN, ts: '999.000001' }] } }, 'not_found'],
  ['replies missing scope', { 'conversations.history': { ok: true, messages: [] }, 'conversations.replies': { ok: false, error: 'missing_scope' } }, 'permission_denied'],
  ['replies thread missing', { 'conversations.history': { ok: true, messages: [] }, 'conversations.replies': { ok: false, error: 'thread_not_found' } }, 'not_found'],
  ['truncated lookup', { 'conversations.history': { ok: true, messages: [] }, 'conversations.replies': { ok: true, messages: [], has_more: true } }, 'ownership_unverified'],
  ['delete denied', { 'chat.delete': { ok: false, error: 'cant_delete_message' } }, 'permission_denied'],
  ['delete raced removal', { 'chat.delete': { ok: false, error: 'message_not_found' } }, 'not_found'],
  ['delete response lost', { 'chat.delete': new Error('offline') }, 'delete_failed'],
  ['delete response incomplete', { 'chat.delete': { ok: true } }, 'delete_failed'],
  ['delete response wrong timestamp', { 'chat.delete': { ok: true, channel: 'CTARGET', ts: '999.000001' } }, 'delete_failed'],
  ['delete rate limit', { 'chat.delete': { ok: false, error: 'ratelimited' } }, 'delete_failed'],
]) {
  test(`delete fails closed: ${label}`, () => fixture(async ({ call, calls }) => {
    const { result, envelope } = await call('delete_message', { channel: 'CTARGET', ts: TS })
    assert.equal(envelope.isError, true)
    assert.equal(result.error, error)
    assert.equal(calls.filter(c => c.method === 'chat.delete').length, Object.hasOwn(responses, 'chat.delete') ? 1 : 0)
    assertDeleteAudit(result, error, { authenticated: !Object.hasOwn(responses, 'auth.test') })
  }, { responses }))
}

test('delete requires explicit channel/ts and forbids caller ownership or broader credentials', () => fixture(async ({ call, calls }) => {
  for (const args of [
    { ts: TS }, { channel: 'CTARGET' }, { channel: '', ts: TS }, { channel: 'CTARGET', ts: 'oops' },
    ...['user', 'bot_id', 'owned', 'token', 'as_user', 'thread_ts', 'recursive'].map(key => ({ channel: 'CTARGET', ts: TS, [key]: true })),
  ]) {
    const { result, envelope } = await call('delete_message', args)
    assert.equal(envelope.isError, true)
    assertCompactDeleteAudit(result)
    assert.equal(result.audit_details.outcome, 'invalid_arguments')
    assert.equal(result.audit_details.reason, 'invalid_arguments')
    assert.equal(result.audit_details.actor_user_id, null)
    assert.equal(result.audit_details.actor_bot_id, null)
  }
  assert.deepEqual(calls, [])
}))

test('delete audit excludes message content and unrecognized remote errors', () => fixture(async ({ call }) => {
  const { result, envelope } = await call('delete_message', { channel: 'CTARGET', ts: TS })
  assert.equal(envelope.isError, true)
  assertDeleteAudit(result, 'delete_failed')
  assert.equal(result.audit_details.reason, 'delete_failed')
  assert.ok(!JSON.stringify(result).includes('PRIVATE_MESSAGE_CONTENT'))
}, { responses: {
  'conversations.history': { ok: true, messages: [{ ...OWN, text: 'PRIVATE_MESSAGE_CONTENT' }] },
  'chat.delete': { ok: false, error: 'PRIVATE_MESSAGE_CONTENT' },
} }))

test('delete audit bounds invalid destinations without API calls', () => fixture(async ({ call, calls }) => {
  for (const args of [
    { channel: 'C' + 'A'.repeat(64), ts: TS },
    { channel: 'C' + 'A'.repeat(21), ts: TS },
    { channel: 'Cbad', ts: TS },
    { channel: 'C|BAD', ts: TS },
    { channel: 'CTARGET\n', ts: TS },
    { channel: 'CTARGET', ts: '1'.repeat(26) + '.000001' },
    { channel: 'CTARGET', ts: '1'.repeat(13) + '.000001' },
    { channel: 'CTARGET', ts: '1.0000001' },
    { channel: 'CTARGET', ts: '1.' },
    { channel: 'CTARGET', ts: '.1' },
    { channel: 'CTARGET', ts: TS + '\n' },
    { channel: 'xoxb-mock', ts: 'PRIVATE_MESSAGE_CONTENT' },
    null,
  ]) {
    const { result, envelope } = await call('delete_message', args)
    assert.equal(envelope.isError, true)
    assertCompactDeleteAudit(result)
    assert.equal(result.audit_details.outcome, 'invalid_arguments')
    assert.equal(result.audit_details.actor_user_id, null)
    assert.equal(result.audit_details.actor_bot_id, null)
    assert.ok(JSON.stringify(result.audit_details).length < 1024)
    assert.ok(!JSON.stringify(result.audit_details).includes('xoxb-mock'))
    assert.ok(!JSON.stringify(result.audit_details).includes('PRIVATE_MESSAGE_CONTENT'))
    assert.equal(result.audit_details.channel, args?.channel === 'CTARGET' ? 'CTARGET' : null)
    assert.equal(result.audit_details.ts, args?.ts === TS ? TS : null)
  }
  assert.deepEqual(calls, [])
}))

test('delete rejects invalid authenticated IDs without copying them to audit', async () => {
  for (const field of ['user_id', 'bot_id']) {
    for (const value of ['A'.repeat(22), 'A'.repeat(65), 'lowercase', 'A|B', 'A\n', '']) {
      await fixture(async ({ call, calls }) => {
        const { result, envelope } = await call('delete_message', { channel: 'CTARGET', ts: TS })
        assert.equal(envelope.isError, true)
        assertDeleteAudit(result, 'ownership_unverified', { authenticated: false })
        assert.equal(result.audit_details.reason, 'identity_incomplete')
        assert.deepEqual(calls.map(c => c.method), ['auth.test'])
      }, { responses: { 'auth.test': { ok: true, user_id: 'UOWN', bot_id: 'BOWN', [field]: value } } })
    }
  }
})

test('delete accepts the minimum ID and timestamp lengths', () => fixture(async ({ call, calls }) => {
  const { result, envelope } = await call('delete_message', { channel: '0', ts: '0.0' })
  assert.ok(!envelope.isError)
  assert.equal(result.ok, true)
  assertCompactDeleteAudit(result)
  assert.equal(result.audit_details.channel, '0')
  assert.equal(result.audit_details.ts, '0.0')
  assert.equal(result.audit_details.actor_user_id, '0')
  assert.equal(result.audit_details.actor_bot_id, '9')
  assert.deepEqual(calls.map(c => c.method), ['auth.test', 'conversations.history', 'chat.delete'])
}, { responses: {
  'auth.test': { ok: true, user_id: '0', bot_id: '9' },
  'conversations.history': { ok: true, messages: [{ ts: '0.0', user: '0', bot_id: '9' }] },
} }))

// Exercise the real MCP handler with every destination/actor at the new limit.
const MAX_CHANNEL = 'C' + 'A'.repeat(20)
const MAX_USER = 'U' + 'A'.repeat(20)
const MAX_BOT = 'B' + 'A'.repeat(20)
const MAX_TS = '9'.repeat(12) + '.' + '9'.repeat(6)
const MAX_MESSAGE = { ts: MAX_TS, user: MAX_USER, bot_id: MAX_BOT }

for (const [label, responses, outcome, reason] of [
  ['success', {}, 'deleted', null],
  ['ownership reject', { 'conversations.history': { ok: true, messages: [{ ...MAX_MESSAGE, user: 'UOTHER' }] } }, 'permission_denied', 'author_mismatch'],
  ['longest ownership reason', { 'conversations.history': { ok: true, messages: [{ ...MAX_MESSAGE, subtype: 'message_deleted' }] } }, 'ownership_unverified', 'unsupported_message_type'],
  ['longest delete reason', { 'chat.delete': { ok: true } }, 'delete_failed', 'delete_response_uncertain'],
  ['API error', { 'chat.delete': { ok: false, error: 'missing_scope' } }, 'permission_denied', 'slack_api_error'],
  ['auth error', { 'auth.test': new Error('offline') }, 'ownership_unverified', 'identity_failed'],
]) {
  test(`delete audit prefix survives 200 characters at maximum lengths: ${label}`, t => fixture(async ({ call }) => {
    const { result, envelope } = await call('delete_message', { channel: MAX_CHANNEL, ts: MAX_TS })
    assert.equal(Boolean(envelope.isError), outcome !== 'deleted')
    // Assert on the actual result BEFORE inspecting its structured companion.
    assert.ok(JSON.stringify(result).slice(0, 200).includes(JSON.stringify(result.audit)),
      'the session log must retain the complete audit at maximum field lengths')
    assert.equal(typeof result.audit, 'string', 'audit must be a compact string')
    assertCompactDeleteAudit(result)
    assert.equal(result.audit_details.outcome, outcome)
    assert.equal(result.audit_details.reason, reason)
    assert.equal(result.audit_details.channel, MAX_CHANNEL)
    assert.equal(result.audit_details.ts, MAX_TS)
    assert.equal(result.audit_details.actor_user_id, label === 'auth error' ? null : MAX_USER)
    assert.equal(result.audit_details.actor_bot_id, label === 'auth error' ? null : MAX_BOT)
    t.diagnostic(`audit=${result.audit.length} chars; prefix through closing quote=${JSON.stringify({ audit: result.audit }).length - 1} chars`)
  }, { responses: {
    'auth.test': { ok: true, user_id: MAX_USER, bot_id: MAX_BOT },
    'conversations.history': { ok: true, messages: [MAX_MESSAGE] },
    ...responses,
  } }))
}

test('delete audit prefix survives rejected arguments with a long validation error', () => fixture(async ({ call, calls }) => {
  const { result, envelope } = await call('delete_message', {
    channel: MAX_CHANNEL, ts: MAX_TS, ['unknown'.repeat(100)]: true,
  })
  assert.equal(envelope.isError, true)
  assert.ok(result.error.length > 200)
  assertCompactDeleteAudit(result)
  assert.equal(result.audit_details.outcome, 'invalid_arguments')
  assert.equal(result.audit_details.reason, 'invalid_arguments')
  assert.equal(result.audit_details.channel, MAX_CHANNEL)
  assert.equal(result.audit_details.ts, MAX_TS)
  assert.equal(result.audit_details.actor_user_id, null)
  assert.equal(result.audit_details.actor_bot_id, null)
  assert.deepEqual(calls, [])
}))
