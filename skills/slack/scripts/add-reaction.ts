#!/usr/bin/env npx tsx
/**
 * Add an emoji reaction to the original message.
 *
 * Usage:
 *   npx tsx add-reaction.ts emoji_name
 *   npx tsx add-reaction.ts --channel C123 --message_ts 123.456 emoji_name
 */

import { slackApi, fail, succeed, parseArgs } from './lib/slack-client.js'

const { channel, messageTs, positional } = parseArgs()
const emoji = positional[0]

if (!emoji) fail('Emoji name required')
if (!channel) fail('Channel required (--channel or SLACK_CHANNEL env)')
if (!messageTs) fail('Message TS required (--message_ts or SLACK_MESSAGE_TS env)')

async function main() {
  await slackApi('reactions.add', { channel, timestamp: messageTs, name: emoji })
  succeed()
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
