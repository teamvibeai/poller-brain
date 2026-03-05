#!/usr/bin/env npx tsx
/**
 * Set the assistant thread status (typing indicator).
 *
 * Usage:
 *   npx tsx set-status.ts "Thinking..."
 */

import { slackApi, fail, succeed, parseArgs } from './lib/slack-client.js'

const { channel, threadTs, positional } = parseArgs()
const status = positional.join(' ')

if (!channel) fail('Channel required')
if (!threadTs) fail('Thread TS required')

async function main() {
  await slackApi('assistant.threads.setStatus', { channel_id: channel, thread_ts: threadTs, status })
  succeed()
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
