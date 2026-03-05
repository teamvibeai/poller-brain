#!/usr/bin/env npx tsx
/**
 * Send a message to a Slack thread.
 *
 * Usage:
 *   npx tsx send-message.ts "Your message here"
 *   npx tsx send-message.ts --text "Your message here"
 *   npx tsx send-message.ts --channel C123 --thread_ts 123.456 "Your message"
 */

import { slackApi, fail, succeed, parseArgs } from './lib/slack-client.js'

const { channel, threadTs, positional, textFromFlag } = parseArgs()
const text = textFromFlag || positional.join(' ')

if (!text) fail('Message text required')
if (!channel) fail('Channel required (--channel or SLACK_CHANNEL env)')
if (!threadTs) fail('Thread TS required (--thread_ts or SLACK_THREAD_TS env)')

async function main() {
  const result = await slackApi('chat.postMessage', {
    channel,
    thread_ts: threadTs,
    text,
    unfurl_links: false,
    unfurl_media: false,
  })
  succeed({ ts: result.ts })
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
