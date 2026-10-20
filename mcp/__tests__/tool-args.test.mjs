// Exercise real tools/call dispatch in BOTH servers, with fetch intercepted.
// Like teamvibe-api-delivery.test.mjs, load the prelude via data URL to avoid stdin.
// Run: node mcp/__tests__/tool-args.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

process.env.SLACK_CHANNEL = 'C_DEFAULT'
delete process.env.SLACK_THREAD_TS
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.TEAMVIBE_API_URL = 'https://teamvibe.invalid'
process.env.TEAMVIBE_POLLER_TOKEN = 'test-token'
process.env.TEAMVIBE_WORKSPACE_ID = 'W_TEST'
process.env.TEAMVIBE_CHANNEL_ID = 'CH_TEST'

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const validatorUrl = pathToFileURL(join(mcpDir, 'lib', 'validate-args.mjs')).href
async function loadServer(file) {
  const src = readFileSync(join(mcpDir, file), 'utf8')
  const prelude = src.split('\nconst rl = createInterface')[0]
    .replace("'./lib/validate-args.mjs'", JSON.stringify(validatorUrl))
  return await import('data:text/javascript,' + encodeURIComponent(prelude + '\nexport { handleRequest }\n'))
}

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }
const realFetch = globalThis.fetch
const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts })
  return { ok: true, json: async () => ({ ok: true, ts: '1.1', items: [] }) }
}
let nextId = 1
async function call(handleRequest, name, args) {
  const params = { name }
  if (args !== undefined) params.arguments = args
  const id = nextId++
  const response = JSON.parse(await handleRequest({ jsonrpc: '2.0', id, method: 'tools/call', params }))
  return { ...response, body: JSON.parse(response.result.content[0].text) }
}
async function rejects(handleRequest, label, name, args, expected) {
  calls.length = 0
  const response = await call(handleRequest, name, args)
  ok(`${label}: isError tool result (no protocol error)`, response.result.isError === true && !response.error)
  ok(`${label}: content has ok:false`, response.body.ok === false)
  ok(`${label}: actionable error text`, response.body.error === expected)
  ok(`${label}: no API call`, calls.length === 0)
}

try {
  const slack = await loadServer('slack.mjs')
  const teamvibe = await loadServer('teamvibe-api.mjs')
  for (const [name, server] of [['slack', slack], ['teamvibe-api', teamvibe]]) {
    const response = JSON.parse(await server.handleRequest({ id: nextId++, method: 'tools/list' }))
    ok(`${name}: every inputSchema forbids additional properties`,
      response.result.tools.length > 0 && response.result.tools.every(t => t.inputSchema.additionalProperties === false))
    await rejects(server.handleRequest, `${name} unknown tool`, 'not_a_tool', { channel_id: 'C1' }, 'Unknown tool: not_a_tool')
  }

  const incident = { channel_id: 'C0CA0CBLA7R', text: 'x' }
  const incidentError = 'Unknown parameter `channel_id` for send_message. Allowed parameters: text, blocks, channel, thread_ts, modals. Did you mean `channel`?'
  await rejects(slack.handleRequest, 'slack #553', 'send_message', incident, incidentError)
  // TeamVibe has no send_message: preserve that error, and test the exact #553
  // arguments against its channel-selecting tool too (channelId instead of channel).
  await rejects(teamvibe.handleRequest, 'teamvibe-api #553 unknown tool', 'send_message', incident, 'Unknown tool: send_message')
  await rejects(teamvibe.handleRequest, 'teamvibe-api #553 arguments', 'list_scheduled_messages', incident,
    'Unknown parameter `channel_id` for list_scheduled_messages. Allowed parameters: channelId. Did you mean `channelId`?')
  await rejects(slack.handleRequest, 'slack missing text', 'send_message', {}, 'Missing required parameter `text` for send_message')
  await rejects(slack.handleRequest, 'slack omitted arguments', 'send_message', undefined, 'Missing required parameter `text` for send_message')
  await rejects(slack.handleRequest, 'slack wrong text type', 'send_message', { text: 1 },
    'Invalid type for parameter `text` for send_message: expected string, got number')
  await rejects(slack.handleRequest, 'slack wrong limit type', 'read_channel', { limit: '20' },
    'Invalid type for parameter `limit` for read_channel: expected number, got string')
  await rejects(slack.handleRequest, 'slack threadTs suggestion', 'send_message', { text: 'x', threadTs: '1.1' },
    'Unknown parameter `threadTs` for send_message. Allowed parameters: text, blocks, channel, thread_ts, modals. Did you mean `thread_ts`?')
  await rejects(slack.handleRequest, 'slack wrong union type', 'send_message', { text: 'x', thread_ts: false },
    'Invalid type for parameter `thread_ts` for send_message: expected string or null, got boolean')
  await rejects(slack.handleRequest, 'slack missing modal view', 'send_message', { text: 'x', modals: [{ label: 'Open' }] },
    'Missing required parameter `modals[0].view` for send_message')
  await rejects(slack.handleRequest, 'slack wrong modal view type', 'send_message', { text: 'x', modals: [{ view: null }] },
    'Invalid type for parameter `modals[0].view` for send_message: expected object, got null')
  await rejects(teamvibe.handleRequest, 'teamvibe-api missing scheduleId', 'delete_scheduled_message', {},
    'Missing required parameter `scheduleId` for delete_scheduled_message')
  await rejects(teamvibe.handleRequest, 'teamvibe-api scheduleID suggestion', 'delete_scheduled_message', { scheduleID: 's1' },
    'Unknown parameter `scheduleID` for delete_scheduled_message. Allowed parameters: scheduleId. Did you mean `scheduleId`?')
  await rejects(teamvibe.handleRequest, 'teamvibe-api wrong prompt type', 'create_scheduled_message', { promptTemplate: 1 },
    'Invalid type for parameter `promptTemplate` for create_scheduled_message: expected string, got number')
  await rejects(teamvibe.handleRequest, 'teamvibe-api wrong origin type', 'create_scheduled_message', { promptTemplate: 'x', origin: [] },
    'Invalid type for parameter `origin` for create_scheduled_message: expected object, got array')
  for (const [name, server, tool] of [['slack', slack, 'send_message'], ['teamvibe-api', teamvibe, 'list_scheduled_messages']]) {
    for (const value of [null, false, 0, '', [], 'text']) {
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      await rejects(server.handleRequest, `${name} invalid arguments ${JSON.stringify(value)}`, tool, value,
        `Invalid type for parameter \`arguments\` for ${tool}: expected object, got ${type}`)
    }
  }

  calls.length = 0
  const validSlack = await call(slack.handleRequest, 'send_message', { text: 'x', channel: 'C_EXPLICIT', thread_ts: null })
  ok('slack valid call succeeds', !validSlack.result.isError && validSlack.body.ok === true)
  ok('slack valid call uses explicit channel and null thread', calls.length === 1 &&
    JSON.parse(calls[0].opts.body).channel === 'C_EXPLICIT' && !('thread_ts' in JSON.parse(calls[0].opts.body)))
  calls.length = 0
  const validTeamvibe = await call(teamvibe.handleRequest, 'list_scheduled_messages')
  ok('teamvibe-api valid omitted arguments succeed', !validTeamvibe.result.isError && validTeamvibe.body.ok === true)
  ok('teamvibe-api valid call reaches API once', calls.length === 1 && calls[0].url.includes('/scheduled-messages?'))
} finally {
  globalThis.fetch = realFetch
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
