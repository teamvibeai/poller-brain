// Regression tests for poller-brain#451. Load the server prelude and mock
// fetch, following slack-reactions.test.mjs; no Slack/network calls are made.
// Run: node mcp/__tests__/slack-sentinel.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

process.env.SLACK_CHANNEL = 'C_DEFAULT'
process.env.SLACK_THREAD_TS = '1000.0001'
process.env.SLACK_BOT_TOKEN = 'xoxb-test'
// Exercise the modal path even when the host has no platform configuration.
process.env.TEAMVIBE_API_URL = 'https://platform.test'
process.env.TEAMVIBE_POLLER_TOKEN = 'test-token'

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'slack.mjs')
const src = readFileSync(serverPath, 'utf8')
const prelude = src.split('// --- stdio transport ---')[0]
  .replace("'./lib/validate-args.mjs'", JSON.stringify(pathToFileURL(join(dirname(serverPath), 'lib', 'validate-args.mjs')).href))
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + '\nexport { handleRequest }\n'))
const { handleRequest, shouldSuppressSentinel } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }
const SENTINEL = 'NO_FURTHER_RESPONSE_NEEDED'

async function callTool(name, args) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const body = opts.headers['Content-Type'] === 'application/json'
      ? JSON.parse(opts.body)
      : opts.headers['Content-Type'] === 'application/x-www-form-urlencoded'
        ? Object.fromEntries(new URLSearchParams(opts.body))
        : opts.body
    calls.push({ url, body })
    return {
      ok: true,
      json: async () => ({
        ok: true, ts: '1000.0002', channel: { is_im: true },
        upload_url: 'https://upload.test/file', file_id: 'F1', modalDefId: 'M1',
      }),
    }
  }
  try {
    const response = JSON.parse(await handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    }))
    return { envelope: response.result, result: JSON.parse(response.result.content[0].text), calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

for (const text of [
  SENTINEL, ` \n\t${SENTINEL}\r\n `, `\`${SENTINEL}\``,
  ` \n\` ${SENTINEL} \`\t`, `"${SENTINEL}"`, `'${SENTINEL}'`,
]) {
  const { envelope, result, calls } = await callTool('send_message', { text })
  ok(`${JSON.stringify(text)}: no Slack API calls (including warning lookups)`, calls.length === 0)
  ok(`${JSON.stringify(text)}: successful suppressed MCP result`, !envelope.isError && result.ok === true && result.suppressed === 'sentinel')
  ok(`${JSON.stringify(text)}: explains nothing was posted`, /nothing was posted/i.test(JSON.stringify(result)))
}

{
  const { result, calls } = await callTool('send_message', { text: SENTINEL, blocks: [], modals: [] })
  ok('empty blocks/modals still suppress', result.suppressed === 'sentinel' && calls.length === 0)
}

// Comparison only: ordinary text, punctuation, and extra/nonmatching wrappers
// must be posted intact; there is no substring removal or recursive unquoting.
for (const text of [
  `The sentinel ${SENTINEL} means no reply is needed.`,
  `${SENTINEL}.`, `prefix ${SENTINEL}`, `${SENTINEL} suffix`,
  `\`\`${SENTINEL}\`\``, `\`"${SENTINEL}"\``, `"${SENTINEL}'`,
  SENTINEL.toLowerCase(), '',
]) {
  const { result, calls } = await callTool('send_message', { text })
  const post = calls.find(c => c.url.endsWith('/chat.postMessage'))
  ok(`${JSON.stringify(text)}: posts unchanged`, result.ok === true && !result.suppressed && post?.body.text === text)
}

{
  const { result, calls } = await callTool('send_message', { text: ` \`${SENTINEL}\` `, blocks: [{ type: 'divider' }] })
  const post = calls.find(c => c.url.endsWith('/chat.postMessage'))
  ok('blocks bypass suppression', result.ok === true && !result.suppressed && !!post)
  ok('blocks and original text preserved', post?.body.text === ` \`${SENTINEL}\` ` && post.body.blocks.some(b => b.type === 'divider'))
}

{
  const { result, calls } = await callTool('send_message', {
    text: SENTINEL, modals: [{ label: 'Open', view: { type: 'modal', blocks: [] } }],
  })
  ok('modals bypass suppression', result.ok === true && !result.suppressed && calls.some(c => c.url.endsWith('/chat.postMessage')))
  ok('modal registration and button update still run', calls.some(c => c.url.endsWith('/modal-definitions')) && calls.some(c => c.url.endsWith('/chat.update')))
}

{
  const { result, calls } = await callTool('update_message', { ts: '1000.0002', text: SENTINEL })
  ok('update_message unaffected', result.ok === true && !result.suppressed && calls.length === 1 && calls[0].url.endsWith('/chat.update') && calls[0].body.text === SENTINEL)
}

{
  const { result, calls } = await callTool('set_status', { text: `\`${SENTINEL}\`` })
  ok('sentinel status suppressed without API calls', result.ok === true && result.suppressed === 'sentinel' && calls.length === 0)
}
for (const text of ['', `Checking ${SENTINEL}`]) {
  const { result, calls } = await callTool('set_status', { text })
  ok(`status ${JSON.stringify(text)} still sent (including clear)`, result.ok === true && calls.length === 1 && calls[0].body.status === text)
}

for (const initial_comment of [` \`${SENTINEL}\` `, `This documents ${SENTINEL}.`]) {
  const { result, calls } = await callTool('upload_file', { filepath: serverPath, initial_comment })
  const complete = calls.find(c => c.url.endsWith('/files.completeUploadExternal'))
  ok('file upload still completes', result.ok === true && calls.length === 3 && JSON.parse(complete?.body.files || '[]')[0]?.id === 'F1')
  ok(`upload comment ${JSON.stringify(initial_comment)}`, initial_comment.startsWith('This')
    ? complete?.body.initial_comment === initial_comment
    : complete && !('initial_comment' in complete.body))
}

// The exported predicate also guards against discarding file-bearing payloads;
// send_message itself currently has no files parameter in its schema.
ok('predicate exported', typeof shouldSuppressSentinel === 'function')
if (shouldSuppressSentinel) {
  ok('predicate recognizes bare sentinel', shouldSuppressSentinel({ text: SENTINEL }))
  ok('empty files permit suppression', shouldSuppressSentinel({ text: SENTINEL, files: [] }))
  ok('files prevent suppression', !shouldSuppressSentinel({ text: SENTINEL, files: [{ id: 'F1' }] }))
  ok('missing/non-string text is not a sentinel', !shouldSuppressSentinel({}) && !shouldSuppressSentinel({ text: null }) && !shouldSuppressSentinel({ text: 42 }))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
