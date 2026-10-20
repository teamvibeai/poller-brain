// Exercise tools/call in both real server preludes; no stdio or live API.
// Like teamvibe-api-delivery.test.mjs, export private helpers via a data URL.
// Run: node mcp/__tests__/mcp-args.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

process.env.SLACK_CHANNEL = 'C_DEFAULT'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
process.env.TEAMVIBE_API_URL = 'https://api.invalid'
process.env.TEAMVIBE_POLLER_TOKEN = 'test-token'
process.env.TEAMVIBE_WORKSPACE_ID = 'W1'

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }
const mcpDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const validatorUrl = pathToFileURL(join(mcpDir, 'lib', 'validate-args.mjs')).href
const realFetch = globalThis.fetch
let calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts })
  return { ok: true, json: async () => ({ ok: true, channel: 'C_DEFAULT', ts: '1.1', items: [] }) }
}

try {
  for (const server of ['slack', 'teamvibe-api']) {
    const src = readFileSync(join(mcpDir, `${server}.mjs`), 'utf8')
    const prelude = src.split('// --- stdio transport ---')[0]
      // Also loads the old TeamVibe server, before it has a transport marker.
      .split('\nconst rl = createInterface(')[0]
      .replace("'./lib/validate-args.mjs'", JSON.stringify(validatorUrl))
    const { handleRequest } = await import('data:text/javascript,' + encodeURIComponent(prelude + '\nexport { handleRequest }\n'))
    const request = async (name, args) => JSON.parse(await handleRequest({ jsonrpc: '2.0', id: 553, method: 'tools/call', params: { name, arguments: args } }))
    const listed = JSON.parse(await handleRequest({ id: 1, method: 'tools/list' })).result.tools
    ok(`${server}: every tool forbids unknown top-level keys`, listed.every((t) => t.inputSchema.additionalProperties === false))

    async function rejected(label, name, args, expected) {
      calls = []
      const response = await request(name, args)
      const body = JSON.parse(response.result.content[0].text)
      ok(`${server}: ${label} is a tool error`, response.result.isError === true && !response.error && response.id === 553)
      ok(`${server}: ${label} reports ok:false`, body.ok === false)
      ok(`${server}: ${label} error text`, body.error === expected)
      ok(`${server}: ${label} makes no API call`, calls.length === 0)
    }

    // TeamVibe has no send_message tool. Use its channel-filtering tool with
    // the identical #553 arguments to prove validation runs there as well.
    const tool = server === 'slack' ? 'send_message' : 'list_scheduled_messages'
    const allowed = server === 'slack' ? 'text, blocks, channel, thread_ts, modals' : 'channelId'
    const suggestion = server === 'slack' ? 'channel' : 'channelId'
    await rejected('#553 payload', tool, { channel_id: 'C0CA0CBLA7R', text: 'x' },
      `Unknown parameter \`channel_id\` for ${tool}. Allowed parameters: ${allowed}. Did you mean \`${suggestion}\`?`)

    const requiredTool = server === 'slack' ? 'send_message' : 'create_scheduled_message'
    const requiredKey = server === 'slack' ? 'text' : 'promptTemplate'
    await rejected('missing required', requiredTool, {}, `Missing required parameter \`${requiredKey}\` for ${requiredTool}`)
    await rejected('wrong type', requiredTool, { [requiredKey]: 4 }, `Invalid type for parameter \`${requiredKey}\` for ${requiredTool}: expected string, got number`)
    for (const args of [null, false, 0, '', []]) {
      await rejected(`non-object ${JSON.stringify(args)}`, tool, args, `Arguments for ${tool} must be an object`)
    }
    await rejected('unknown tool unchanged', 'not_a_tool', {}, 'Unknown tool: not_a_tool')

    if (server === 'slack') {
      await rejected('modal missing view', 'send_message', { text: 'x', modals: [{}] }, 'Missing required parameter `modals[0].view` for send_message')
      calls = []
      const response = await request('send_message', { text: 'x', thread_ts: null })
      ok('slack: valid nullable thread reaches API', !response.result.isError && calls.some((c) => c.url.endsWith('chat.postMessage')))
    } else {
      await rejected('scheduleID suggestion', 'delete_scheduled_message', { scheduleID: 'S1' }, 'Unknown parameter `scheduleID` for delete_scheduled_message. Allowed parameters: scheduleId. Did you mean `scheduleId`?')
      calls = []
      const response = await request('list_scheduled_messages', undefined)
      ok('teamvibe-api: omitted optional arguments reach API', !response.result.isError && calls.length === 1)
    }
  }
} finally {
  globalThis.fetch = realFetch
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
