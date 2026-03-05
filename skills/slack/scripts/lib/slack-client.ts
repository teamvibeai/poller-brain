#!/usr/bin/env npx tsx
/**
 * Shared Slack API client using plain fetch (no dependencies).
 */

const BOT_TOKEN = process.env['SLACK_BOT_TOKEN']

if (!BOT_TOKEN) {
  console.error('SLACK_BOT_TOKEN not set')
  process.exit(1)
}

export async function slackApi(method: string, body: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error}`)
  return data
}

export function fail(error: string): never {
  console.log(JSON.stringify({ ok: false, error }))
  process.exit(1)
}

export function succeed(data: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ ok: true, ...data }))
  process.exit(0)
}

export function parseArgs(argv: string[] = process.argv.slice(2)) {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  const knownFlags = ['--channel', '--thread_ts', '--thread-ts', '--message_ts', '--message-ts', '--text']
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    const eqMatch = arg.match(/^(--[\w-]+)=(.*)$/)
    if (eqMatch) {
      flags[eqMatch[1]!] = eqMatch[2]!
      i++
      continue
    }
    if (knownFlags.includes(arg) && i + 1 < argv.length) {
      flags[arg] = argv[i + 1]!
      i += 2
      continue
    }
    positional.push(arg)
    i++
  }

  const textFromFlag = flags['--text']
  const channel = flags['--channel'] || process.env['SLACK_CHANNEL']
  const threadTs = flags['--thread_ts'] || flags['--thread-ts'] || process.env['SLACK_THREAD_TS']
  const messageTs = flags['--message_ts'] || flags['--message-ts'] || process.env['SLACK_MESSAGE_TS']

  return { channel, threadTs, messageTs, positional, textFromFlag }
}
