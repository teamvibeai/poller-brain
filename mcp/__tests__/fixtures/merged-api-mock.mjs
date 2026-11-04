// Child-process preload: mock only network I/O, never the MCP handlers.
const replies = new Map([
  ['https://slack.com/api/chat.postMessage', { ok: true, channel: 'C_TEST', ts: '1234.567890' }],
  ['https://api.invalid/scheduled-messages?workspaceId=W_TEST&channelId=TC_TEST', { items: [], marker: 'schedule-dispatched' }],
  ['https://api.invalid/feedback', { ok: true, marker: 'feedback-dispatched' }],
])
globalThis.fetch = async (url, options) => {
  if (!replies.has(String(url))) throw new Error(`Unexpected API call: ${url}`)
  process.stderr.write(JSON.stringify({
    url: String(url), method: options.method, authorization: options.headers.Authorization,
    ...(options.body ? { body: JSON.parse(options.body) } : {}),
  }) + '\n')
  return new Response(JSON.stringify(replies.get(String(url))), { headers: { 'content-type': 'application/json' } })
}
