#!/usr/bin/env node
/**
 * Slack MCP Server — zero-dependency MCP server for Slack communication.
 * Implements JSON-RPC 2.0 over stdio using only Node.js built-ins + fetch().
 *
 * Environment variables (set by claude-spawner):
 *   SLACK_BOT_TOKEN  — Slack bot OAuth token
 *   SLACK_CHANNEL    — Default channel ID
 *   SLACK_THREAD_TS  — Default thread timestamp
 *   SLACK_MESSAGE_TS — Original message timestamp (for reactions)
 */

import { createInterface } from 'readline'

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const DEFAULT_CHANNEL = process.env.SLACK_CHANNEL
const DEFAULT_THREAD_TS = process.env.SLACK_THREAD_TS
const DEFAULT_MESSAGE_TS = process.env.SLACK_MESSAGE_TS

// --- Slack API helper ---

async function slackApi(method, body) {
  // Some Slack methods (conversations.replies, conversations.history) require form-urlencoded
  const useForm = method.startsWith('conversations.')
  const headers = { Authorization: `Bearer ${BOT_TOKEN}` }
  let reqBody
  if (useForm) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    reqBody = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString()
  } else {
    headers['Content-Type'] = 'application/json'
    reqBody = JSON.stringify(body)
  }
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers,
    body: reqBody,
  })
  const data = await resp.json()
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error}`)
  return data
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'send_message',
    description: 'Send a message to the Slack thread. Supports full Slack markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text (supports Slack markdown: *bold*, _italic_, `code`, ```code blocks```, > quotes)' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        thread_ts: { type: 'string', description: 'Thread timestamp (default: current thread)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'add_reaction',
    description: 'Add an emoji reaction to the original message.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Emoji name without colons (e.g., "eyes", "white_check_mark")' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        timestamp: { type: 'string', description: 'Message timestamp to react to (default: original message)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'remove_reaction',
    description: 'Remove an emoji reaction from the original message.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Emoji name without colons' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        timestamp: { type: 'string', description: 'Message timestamp (default: original message)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'read_thread',
    description: 'Read message history from the current thread.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default: 20)' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        thread_ts: { type: 'string', description: 'Thread timestamp (default: current thread)' },
      },
    },
  },
  {
    name: 'read_channel',
    description: 'Read recent message history from a channel (not a thread).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default: 20)' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
      },
    },
  },
  {
    name: 'upload_snippet',
    description: 'Upload a code or text snippet to the thread. Use for long outputs, code blocks, logs, or structured data instead of pasting into a message.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Snippet title' },
        content: { type: 'string', description: 'Snippet content' },
        filetype: { type: 'string', description: 'File type (default: "text"). Common: javascript, python, json, markdown, csv' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'download_file',
    description: 'Download a file from Slack (e.g., files shared in messages). Returns the file content as text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Slack file URL (url_private from file objects)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload a local file to the Slack thread.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Absolute path to the local file' },
        title: { type: 'string', description: 'File title (default: filename)' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        thread_ts: { type: 'string', description: 'Thread timestamp (default: current thread)' },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'set_status',
    description: 'Set the typing indicator text (e.g., "Searching...", "Analyzing..."). Use empty string to clear.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Status text to display (empty string clears status)' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        thread_ts: { type: 'string', description: 'Thread timestamp (default: current thread)' },
      },
      required: ['text'],
    },
  },
]

// --- Tool handlers ---

async function handleTool(name, args) {
  switch (name) {
    case 'send_message': {
      const channel = args.channel || DEFAULT_CHANNEL
      const thread_ts = args.thread_ts || DEFAULT_THREAD_TS
      if (!channel) throw new Error('channel required')
      const body = {
        channel,
        text: args.text,
        unfurl_links: false,
        unfurl_media: false,
      }
      if (thread_ts) body.thread_ts = thread_ts
      const result = await slackApi('chat.postMessage', body)
      return { ok: true, ts: result.ts }
    }

    case 'add_reaction': {
      const channel = args.channel || DEFAULT_CHANNEL
      const timestamp = args.timestamp || DEFAULT_MESSAGE_TS
      if (!channel) throw new Error('channel required')
      if (!timestamp) throw new Error('timestamp required')
      try {
        await slackApi('reactions.add', { channel, timestamp, name: args.name })
      } catch (e) {
        if (e.message?.includes('already_reacted')) return { ok: true, already_reacted: true }
        throw e
      }
      return { ok: true }
    }

    case 'remove_reaction': {
      const channel = args.channel || DEFAULT_CHANNEL
      const timestamp = args.timestamp || DEFAULT_MESSAGE_TS
      if (!channel) throw new Error('channel required')
      if (!timestamp) throw new Error('timestamp required')
      try {
        await slackApi('reactions.remove', { channel, timestamp, name: args.name })
      } catch (e) {
        if (e.message?.includes('no_reaction')) return { ok: true, no_reaction: true }
        throw e
      }
      return { ok: true }
    }

    case 'read_thread': {
      const channel = args.channel || DEFAULT_CHANNEL
      const ts = args.thread_ts || DEFAULT_THREAD_TS
      const limit = args.limit || 20
      if (!channel) throw new Error('channel required')
      if (!ts) throw new Error('thread_ts required')
      const result = await slackApi('conversations.replies', { channel, ts, limit })
      const messages = (result.messages || []).map((m) => ({
        user: m.user || m.bot_id || 'unknown',
        text: m.text || '',
        ts: m.ts,
        is_bot: Boolean(m.bot_id),
        ...(m.files?.length && {
          files: m.files.map((f) => ({
            name: f.name,
            mimetype: f.mimetype,
            url: f.url_private,
            size: f.size,
          })),
        }),
      }))
      return { ok: true, messages }
    }

    case 'read_channel': {
      const channel = args.channel || DEFAULT_CHANNEL
      const limit = args.limit || 20
      if (!channel) throw new Error('channel required')
      const result = await slackApi('conversations.history', { channel, limit })
      const messages = (result.messages || []).map((m) => ({
        user: m.user || m.bot_id || 'unknown',
        text: m.text || '',
        ts: m.ts,
        is_bot: Boolean(m.bot_id),
        thread_ts: m.thread_ts,
        reply_count: m.reply_count,
      }))
      return { ok: true, messages }
    }

    case 'upload_snippet': {
      const channel = args.channel || DEFAULT_CHANNEL
      const thread_ts = args.thread_ts || DEFAULT_THREAD_TS
      const filetype = args.filetype || 'text'
      if (!channel) throw new Error('channel required')
      if (!thread_ts) throw new Error('thread_ts required')

      // Step 1: Get upload URL
      const upload = await slackApi('files.getUploadURLExternal', {
        filename: `${args.title}.${filetype}`,
        length: Buffer.byteLength(args.content, 'utf-8'),
      })

      // Step 2: Upload content
      const uploadResp = await fetch(upload.upload_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: args.content,
      })
      if (!uploadResp.ok) throw new Error(`Upload failed: ${uploadResp.statusText}`)

      // Step 3: Complete upload
      await slackApi('files.completeUploadExternal', {
        files: [{ id: upload.file_id, title: args.title }],
        channel_id: channel,
        thread_ts,
      })
      return { ok: true }
    }

    case 'download_file': {
      const resp = await fetch(args.url, {
        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
      })
      if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`)
      const text = await resp.text()
      return { ok: true, content: text, size: text.length }
    }

    case 'upload_file': {
      const { readFileSync, statSync } = await import('fs')
      const { basename } = await import('path')

      const channel = args.channel || DEFAULT_CHANNEL
      const thread_ts = args.thread_ts || DEFAULT_THREAD_TS
      if (!channel) throw new Error('channel required')
      if (!thread_ts) throw new Error('thread_ts required')

      const filename = basename(args.filepath)
      const title = args.title || filename
      const content = readFileSync(args.filepath)
      const size = statSync(args.filepath).size

      // Step 1: Get upload URL
      const upload = await slackApi('files.getUploadURLExternal', {
        filename,
        length: size,
      })

      // Step 2: Upload file
      const uploadResp = await fetch(upload.upload_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content,
      })
      if (!uploadResp.ok) throw new Error(`Upload failed: ${uploadResp.statusText}`)

      // Step 3: Complete upload
      await slackApi('files.completeUploadExternal', {
        files: [{ id: upload.file_id, title }],
        channel_id: channel,
        thread_ts,
      })
      return { ok: true, filename }
    }

    case 'set_status': {
      const channel = args.channel || DEFAULT_CHANNEL
      const thread_ts = args.thread_ts || DEFAULT_THREAD_TS
      if (!channel) throw new Error('channel required')
      if (!thread_ts) throw new Error('thread_ts required')
      await slackApi('assistant.threads.setStatus', {
        channel_id: channel,
        thread_ts,
        status: args.text,
      })
      return { ok: true }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// --- JSON-RPC 2.0 / MCP protocol ---

function jsonrpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleRequest(req) {
  const { id, method, params } = req

  switch (method) {
    case 'initialize':
      return jsonrpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'slack', version: '1.0.0' },
      })

    case 'notifications/initialized':
      return null // no response for notifications

    case 'tools/list':
      return jsonrpcResponse(id, { tools: TOOLS })

    case 'tools/call': {
      const { name, arguments: args } = params
      try {
        const result = await handleTool(name, args || {})
        return jsonrpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        })
      } catch (e) {
        return jsonrpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        })
      }
    }

    default:
      // Ignore unknown notifications (method without id)
      if (id === undefined) return null
      return jsonrpcError(id, -32601, `Method not found: ${method}`)
  }
}

// --- stdio transport ---

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', async (line) => {
  if (!line.trim()) return
  try {
    const req = JSON.parse(line)
    const response = await handleRequest(req)
    if (response) {
      process.stdout.write(response + '\n')
    }
  } catch (e) {
    const errResp = jsonrpcError(null, -32700, `Parse error: ${e.message}`)
    process.stdout.write(errResp + '\n')
  }
})

rl.on('close', () => process.exit(0))
