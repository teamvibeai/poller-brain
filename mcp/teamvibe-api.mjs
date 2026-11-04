#!/usr/bin/env node
// Legacy teamvibe-api transport. Keep this entrypoint for old pollers and resumed sessions.
import { createInterface } from 'readline'
import { handleRequest } from './lib/teamvibe-api-tools.mjs'

// --- stdio transport ---

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', async (line) => {
  if (!line.trim()) return
  try {
    const req = JSON.parse(line)
    const response = await handleRequest(req)
    if (response) process.stdout.write(response + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${e.message}` } }) + '\n')
  }
})

rl.on('close', () => process.exit(0))
