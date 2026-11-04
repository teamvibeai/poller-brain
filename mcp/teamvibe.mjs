#!/usr/bin/env node
// Standalone merged transport over the same handlers as the legacy servers.
import { createInterface } from 'node:readline'
import * as slack from './lib/slack-tools.mjs'
import * as api from './lib/teamvibe-api-tools.mjs'

const apiNames = {
  create_scheduled_message: 'schedule_create',
  list_scheduled_messages: 'schedule_list',
  delete_scheduled_message: 'schedule_delete',
  submit_feedback: 'feedback_submit',
}
const routes = new Map()
const tools = []
for (const [domain, registry] of [['slack', slack], ['api', api]]) {
  for (const tool of registry.TOOLS) {
    const name = domain === 'slack' ? `slack_${tool.name}` : apiNames[tool.name]
    if (!name || routes.has(name)) throw new Error(`Unsupported catalog v1 tool: ${tool.name}`)
    tools.push({ ...tool, name })
    routes.set(name, { registry, legacyName: tool.name })
  }
}
if (slack.TOOLS.length !== 23 || api.TOOLS.length !== 4) throw new Error('Incomplete teamvibe catalog v1')

async function handleRequest(req) {
  const { id, method, params } = req
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'teamvibe', version: '1.0.0' },
  } }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } }
  if (method === 'tools/call') {
    const route = routes.get(params?.name)
    if (!route) return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Unknown tool: ${params?.name}` }) }], isError: true,
    } }
    return JSON.parse(await route.registry.handleRequest({ ...req, params: { ...params, name: route.legacyName } }))
  }
  if (id === undefined) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
}

const rl = createInterface({ input: process.stdin, terminal: false })
// Drain outstanding API work before EOF shutdown.
let pending = Promise.resolve()
rl.on('line', line => {
  if (!line.trim()) return
  pending = pending.then(async () => {
    try {
      const response = await handleRequest(JSON.parse(line))
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } }) + '\n')
    }
  })
})
rl.on('close', async () => { await pending })
