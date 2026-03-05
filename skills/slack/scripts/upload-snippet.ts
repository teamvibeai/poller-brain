#!/usr/bin/env npx tsx
/**
 * Upload a code/text snippet to a Slack thread.
 *
 * Usage:
 *   npx tsx upload-snippet.ts "title" "content" [filetype]
 */

import { slackApi, fail, succeed, parseArgs } from './lib/slack-client.js'

const { channel, threadTs, positional } = parseArgs()
const [title, content, filetype = 'text'] = positional

if (!title || !content) fail('Title and content required')
if (!channel) fail('Channel required')
if (!threadTs) fail('Thread TS required')

async function main() {
  // Step 1: Get upload URL
  const upload = await slackApi('files.getUploadURLExternal', {
    filename: `${title}.${filetype}`,
    length: Buffer.byteLength(content!, 'utf-8'),
  })

  // Step 2: Upload content to the URL
  const uploadResp = await fetch(upload.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content,
  })
  if (!uploadResp.ok) fail(`Upload failed: ${uploadResp.statusText}`)

  // Step 3: Complete the upload
  await slackApi('files.completeUploadExternal', {
    files: [{ id: upload.file_id, title }],
    channel_id: channel,
    thread_ts: threadTs,
  })

  succeed()
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
