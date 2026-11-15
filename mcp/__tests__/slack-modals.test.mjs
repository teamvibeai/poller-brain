import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverUrl = new URL('../slack.mjs', import.meta.url)
const source = readFileSync(fileURLToPath(serverUrl), 'utf8').split('// --- stdio transport ---')[0]
  .replace(/'(\.\/lib\/[^']+)'/g, (_, path) => JSON.stringify(new URL(path, serverUrl).href))
let instance = 0
const TS = '1000.000002'
const modal = (fields = {}) => ({ view: { type: 'modal', title: { type: 'plain_text', text: 'Form' }, blocks: [], ...fields } })
const invalid = () => modal({ title: { type: 'plain_text', text: 'SECRET'.repeat(5) } })

async function fixture(run, { env = {}, registration, update } = {}) {
  const originalEnv = { ...process.env }, originalFetch = globalThis.fetch
  Object.assign(process.env, {
    SLACK_BOT_TOKEN: 'SECRET_BOT_TOKEN', SLACK_CHANNEL: 'CDEFAULT', SLACK_THREAD_TS: '1000.000001',
    TEAMVIBE_API_URL: 'https://platform.invalid', TEAMVIBE_POLLER_TOKEN: 'SECRET_TOKEN', ...env,
  })
  const calls = []
  let registrations = 0
  globalThis.fetch = async (url, options) => {
    const method = url.split('/').at(-1)
    const body = options.headers['Content-Type'] === 'application/json'
      ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body))
    calls.push({ method, body })
    if (method === 'modal-definitions' && registration) return registration(registrations++)
    if (method === 'chat.update' && update) return update()
    const data = {
      'chat.postMessage': { ok: true, ts: TS }, 'chat.update': { ok: true, ts: TS },
      'modal-definitions': { modalDefId: method === 'modal-definitions' ? 'M' + ++registrations : '' },
      'conversations.info': { ok: true, channel: { is_im: true } },
      'conversations.replies': { ok: true, messages: [] },
    }[method]
    assert.ok(data, `unexpected call: ${method}`)
    return { ok: true, status: 200, json: async () => data }
  }
  try {
    const { handleRequest } = await import('data:text/javascript,' + encodeURIComponent(source + '\nexport { handleRequest }\n') + `#${instance++}`)
    const call = async (args) => {
      const response = JSON.parse(await handleRequest({ jsonrpc: '2.0', id: 558, method: 'tools/call', params: { name: 'send_message', arguments: { text: 'Form', ...args } } }))
      assert.equal(response.id, 558)
      assert.equal(response.error, undefined)
      return { envelope: response.result, result: JSON.parse(response.result.content[0].text) }
    }
    await run({ call, calls })
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  }
}

for (const [label, args, env] of [
  ['ordinary', {}, {}], ['dry run', { dry_run: true }, {}],
  ['missing platform credentials', {}, { TEAMVIBE_API_URL: '', TEAMVIBE_POLLER_TOKEN: '' }],
  ['dry run without credentials', { dry_run: true }, { TEAMVIBE_API_URL: '', TEAMVIBE_POLLER_TOKEN: '' }],
  ['sentinel', { text: 'NO_FURTHER_RESPONSE_NEEDED' }, {}],
]) {
  for (const later of [false, true]) {
    test(`invalid ${later ? 'second' : 'first'} modal: ${label} has zero calls`, () => fixture(async ({ call, calls }) => {
      const { result, envelope } = await call({ ...args, modals: later ? [modal(), invalid()] : [invalid()] })
      assert.equal(envelope.isError, true)
      assert.equal(result.ok, false)
      assert.equal(result.error, `Invalid value for parameter \`modals[${later ? 1 : 0}].view.title.text\` for send_message: maximum length 24`)
      assert.ok(!JSON.stringify(result).includes('SECRET'))
      assert.deepEqual(calls, [])
    }, { env }))
  }
}

for (const [label, change, path] of [
  ['missing submit', v => { v.blocks = [{ type: 'input', block_id: 'x', element: { type: 'plain_text_input', action_id: 'x' } }] }, 'submit'],
  ['duplicate block ID', v => { v.blocks = [{ type: 'divider', block_id: 'x' }, { type: 'divider', block_id: 'x' }] }, 'blocks[1].block_id'],
  ['oversized option', v => { v.blocks = [{ type: 'actions', elements: [{ type: 'static_select', action_id: 'x', options: [{ text: { type: 'plain_text', text: 'Label' }, value: 'x'.repeat(151) }] }] }] }, 'blocks[0].elements[0].options[0].value'],
]) {
  test(`${label} reaches the MCP error boundary before posting`, () => fixture(async ({ call, calls }) => {
    const m = modal(); change(m.view)
    const { result, envelope } = await call({ modals: [m] })
    assert.equal(envelope.isError, true)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes(`modals[0].view.${path}`))
    assert.deepEqual(calls, [])
  }))
}

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const failureCases = [
  ['HTTP 400', () => response({ error: 'SECRET_BACKEND' }, 400), 'http_error', 400],
  ['HTTP', () => response({ error: 'SECRET_BACKEND' }, 503), 'http_error', 503],
  ['HTTP non-JSON', () => ({ ok: false, status: 502, json: async () => { throw new Error('SECRET_JSON') } }), 'http_error', 502],
  ['transport', () => { throw new Error('SECRET_NETWORK') }, 'transport_error', null],
  ['JSON', () => ({ ok: true, status: 200, json: async () => { throw new Error('SECRET_JSON') } }), 'invalid_json', 200],
  ...[null, [], 'SECRET', {}, { modalDefId: '' }, { modalDefId: '   ' }, { modalDefId: 12 }].map((body, i) => [`invalid body ${i}`, () => response(body), 'invalid_response', 200]),
  ['application', () => response({ ok: false, error: 'SECRET_BACKEND', modalDefId: 'M' }), 'application_error', 200],
  ['error envelope', () => response({ error: 'SECRET_BACKEND', modalDefId: 'M' }), 'application_error', 200],
]
for (const [label, registration, code, status] of failureCases) {
  for (const index of [0, 1]) {
    test(`registration ${label} at index ${index} stops batch and reports publication`, () => fixture(async ({ call, calls }) => {
      const { result, envelope } = await call({ channel: 'CTARGET', modals: [modal(), modal(), modal()] })
      assert.equal(envelope.isError, true)
      assert.equal(result.ok, false)
      assert.equal(result.stage, 'modal_registration')
      assert.equal(result.modal_index, index)
      assert.equal(result.code, code)
      assert.equal(result.status, status)
      assert.equal(result.message_posted, true)
      assert.equal(result.channel, 'CTARGET')
      assert.equal(result.ts, TS)
      assert.ok(!JSON.stringify(result).includes('SECRET'))
      assert.deepEqual(calls.map(c => c.method), ['chat.postMessage', ...Array(index + 1).fill('modal-definitions')])
    }, { registration: i => i < index ? response({ modalDefId: 'M1' }) : registration() }))
  }
}

for (const [label, update] of [
  ['Slack error', () => response({ ok: false, error: 'SECRET_SLACK' })],
  ['transport', () => { throw new Error('SECRET_NETWORK') }],
  ['JSON', () => ({ ok: true, status: 200, json: async () => { throw new Error('SECRET_JSON') } })],
]) {
  test(`button update ${label} retains publication context`, () => fixture(async ({ call, calls }) => {
    const { result, envelope } = await call({ channel: 'CTARGET', modals: [modal(), modal()] })
    assert.equal(envelope.isError, true)
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'modal_button_update')
    assert.equal(result.message_posted, true)
    assert.equal(result.channel, 'CTARGET')
    assert.equal(result.ts, TS)
    assert.ok(!JSON.stringify(result).includes('SECRET'))
    assert.deepEqual(calls.map(c => c.method), ['chat.postMessage', 'modal-definitions', 'modal-definitions', 'chat.update'])
  }, { update }))
}

for (const [label, args, env, expectedThread] of [
  ['session thread', {}, {}, '1000.000001'],
  ['explicit thread', { thread_ts: '2000.000001' }, {}, '2000.000001'],
  ['explicit root', { thread_ts: null }, {}, TS],
  ['sessionless root', {}, { SLACK_THREAD_TS: '' }, TS],
]) {
  test(`valid ${label} preserves view, callback precedence and routing`, () => fixture(async ({ call, calls }) => {
    const m = modal({ callback_id: 'view_callback', unknown_future_field: { preserve: true } }); m.callbackId = 'wrapper_callback'
    const before = JSON.stringify(m)
    const { result, envelope } = await call({ channel: 'CTARGET', modals: [m, modal({ callback_id: 'fallback' })], ...args })
    assert.ok(!envelope.isError)
    assert.equal(result.ok, true)
    assert.equal(JSON.stringify(m), before)
    const registrations = calls.filter(c => c.method === 'modal-definitions')
    assert.deepEqual(registrations[0].body.viewDefinition, m.view)
    assert.equal(registrations[0].body.callbackId, 'wrapper_callback')
    assert.equal(registrations[1].body.callbackId, 'fallback')
    assert.ok(registrations.every(c => c.body.threadTs === expectedThread && c.body.slackChannel === 'CTARGET'))
    assert.equal(calls[0].body.thread_ts, expectedThread === TS ? undefined : expectedThread)
    assert.deepEqual(calls.slice(0, 4).map(c => c.method), ['chat.postMessage', 'modal-definitions', 'modal-definitions', 'chat.update'])
    const buttons = calls[3].body.blocks.at(-1).elements
    assert.equal(buttons.length, 2)
    assert.ok(buttons.every(b => !b.action_id.includes('undefined')))
  }, { env }))
}

test('valid modals stay disabled without platform credentials', () => fixture(async ({ call, calls }) => {
  const { result, envelope } = await call({ modals: [modal()] })
  assert.ok(!envelope.isError)
  assert.equal(result.ok, true)
  assert.ok(!calls.some(c => ['modal-definitions', 'chat.update'].includes(c.method)))
}, { env: { TEAMVIBE_API_URL: '', TEAMVIBE_POLLER_TOKEN: '' } }))

test('preflight reports bounded modal validation with no calls', () => fixture(async ({ call, calls }) => {
  const { result, envelope } = await call({ dry_run: true, modals: [modal()] })
  assert.ok(!envelope.isError)
  assert.ok(result.validation.checked.includes('modal_views'))
  assert.match(JSON.stringify(result.validation.limitations), /full Block Kit/)
  assert.deepEqual(calls, [])
}))


test('registration status is sanitized to a numeric HTTP status or null', () => fixture(async ({ call, calls }) => {
  const { result, envelope } = await call({ modals: [modal()] })
  assert.equal(envelope.isError, true)
  assert.equal(result.status, null)
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  assert.deepEqual(calls.map(c => c.method), ['chat.postMessage', 'modal-definitions'])
}, { registration: () => ({ ok: false, status: 'SECRET_STATUS', json: async () => ({ error: 'SECRET' }) }) }))
