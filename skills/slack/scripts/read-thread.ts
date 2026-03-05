#!/usr/bin/env npx tsx
/**
 * Read thread history from a Slack thread.
 *
 * Usage:
 *   npx tsx read-thread.ts [limit]
 *   npx tsx read-thread.ts --channel C123 --thread_ts 123.456 [limit]
 */

import { slackApi, fail, succeed, parseArgs } from './lib/slack-client.js'

const { channel, threadTs, positional } = parseArgs()
const limit = parseInt(positional[0] || '20', 10)

if (!channel) fail('Channel required (--channel or SLACK_CHANNEL env)')
if (!threadTs) fail('Thread TS required (--thread_ts or SLACK_THREAD_TS env)')

async function main() {
  const result = await slackApi('conversations.replies', { channel, ts: threadTs, limit })
  const messages = (result.messages || []).map((m: any) => ({
    user: m.user || m.bot_id || 'unknown',
    text: m.text || '',
    ts: m.ts,
    is_bot: Boolean(m.bot_id),
  }))
  succeed({ messages })
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
