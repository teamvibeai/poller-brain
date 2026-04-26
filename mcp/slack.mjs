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

const API_URL = process.env.TEAMVIBE_API_URL
const TOKEN = process.env.TEAMVIBE_POLLER_TOKEN
const WORKSPACE_ID = process.env.TEAMVIBE_WORKSPACE_ID
const CHANNEL_ID = process.env.TEAMVIBE_CHANNEL_ID
const BOT_ID = process.env.TEAMVIBE_BOT_ID
const POLLER_ID = process.env.TEAMVIBE_POLLER_ID

// --- Slack API helper ---

async function slackApi(method, body) {
  // Some Slack methods (conversations.replies, conversations.history) require form-urlencoded
  const useForm = method.startsWith('conversations.') || method.startsWith('files.')
  const headers = { Authorization: `Bearer ${BOT_TOKEN}` }
  let reqBody
  if (useForm) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    reqBody = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString()
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
    description: 'Send a message to the Slack thread. Supports full Slack markdown and Block Kit blocks (for buttons, sections, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text (supports Slack markdown: *bold*, _italic_, `code`, ```code blocks```, > quotes). Also used as fallback for blocks.' },
        blocks: { type: 'array', description: 'Optional Block Kit blocks array (e.g. sections, actions with buttons). See https://api.slack.com/block-kit', items: { type: 'object' } },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        thread_ts: { type: ['string', 'null'], description: 'Thread timestamp (default: current thread). Pass null to send a top-level channel message even when in a thread session.' },
        modals: {
          type: 'array',
          description: 'Modal form definitions to attach as buttons. Each opens a Slack modal when clicked.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button label (default: "Open Form")' },
              view: { type: 'object', description: 'Slack Block Kit view object with type, title, blocks, submit, close' },
              callbackId: { type: 'string', description: 'Identifier for matching submissions to requests' },
            },
            required: ['view'],
          },
        },
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
    name: 'read_channel_info',
    description: 'Get channel metadata: name, topic, purpose/description, member count, and privacy status. Useful for understanding channel context at the start of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
      },
    },
  },
  {
    name: 'set_channel_topic',
    description: 'Set the topic of a Slack channel. The topic appears at the top of the channel.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'New topic text' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'set_channel_purpose',
    description: 'Set the purpose/description of a Slack channel.',
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'New purpose text' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
      },
      required: ['purpose'],
    },
  },
  {
    name: 'list_pins',
    description: 'List pinned items in a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
      },
    },
  },
  {
    name: 'list_bookmarks',
    description: 'List bookmarks (links pinned at the top) of a channel.',
    inputSchema: {
      type: 'object',
      properties: {
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
    description: 'Download a file from Slack. For small text files (<100KB), returns content inline. For larger or binary files (images, PDFs), saves to /tmp and returns the file path — use the Read tool to view the file.',
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
        initial_comment: { type: 'string', description: 'Text message posted alongside the file (appears as one message instead of separate file + text)' },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        thread_ts: { type: 'string', description: 'Thread timestamp (default: current thread)' },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'update_message',
    description: 'Update an existing message. Use after button_click events to change button states, show confirmations, or update content in-place.',
    inputSchema: {
      type: 'object',
      properties: {
        ts: { type: 'string', description: 'Timestamp of the message to update (required)' },
        text: { type: 'string', description: 'New fallback text for the message' },
        blocks: { type: 'array', description: 'New Block Kit blocks to replace existing ones', items: { type: 'object' } },
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
      },
      required: ['ts', 'text'],
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
      // Allow explicit opt-out of thread context: thread_ts=null → top-level message
      const thread_ts = args.thread_ts === undefined ? DEFAULT_THREAD_TS : args.thread_ts
      if (!channel) throw new Error('channel required')

      let blocks = args.blocks ? [...args.blocks] : []
      const hasModals = args.modals?.length && API_URL && TOKEN

      // Send the message first (without modal buttons if top-level)
      // We need the message ts for thread context when there's no thread_ts
      const body = {
        channel,
        text: args.text,
        unfurl_links: false,
        unfurl_media: false,
      }
      if (blocks.length) body.blocks = blocks
      if (thread_ts) body.thread_ts = thread_ts
      const result = await slackApi('chat.postMessage', body)

      // Register modal definitions after sending — use message ts as thread context
      // when no thread_ts exists (top-level channel messages)
      if (hasModals) {
        const effectiveThreadTs = thread_ts || result.ts
        const buttons = []
        for (const modal of args.modals) {
          try {
            const resp = await fetch(`${API_URL}/modal-definitions`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                channelId: CHANNEL_ID,
                botId: BOT_ID,
                pollerId: POLLER_ID,
                slackChannel: channel,
                threadTs: effectiveThreadTs,
                callbackId: modal.callbackId || modal.view?.callback_id,
                viewDefinition: modal.view,
              }),
            })
            const data = await resp.json()
            if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`)

            buttons.push({
              type: 'button',
              text: { type: 'plain_text', text: modal.label || 'Open Form' },
              action_id: `modal:${data.modalDefId}`,
              value: `modal_def_id:${data.modalDefId}`,
            })
          } catch (e) {
            console.error('Failed to register modal:', e.message)
          }
        }

        // Update the message to add modal buttons
        if (buttons.length) {
          const updatedBlocks = [...blocks, { type: 'actions', elements: buttons }]
          await slackApi('chat.update', {
            channel,
            ts: result.ts,
            text: args.text,
            blocks: updatedBlocks,
          })
        }
      }

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

    case 'read_channel_info': {
      const channel = args.channel || DEFAULT_CHANNEL
      if (!channel) throw new Error('channel required')
      const result = await slackApi('conversations.info', { channel })
      const ch = result.channel
      return {
        ok: true,
        channel: {
          id: ch.id,
          name: ch.name,
          topic: ch.topic?.value || '',
          purpose: ch.purpose?.value || '',
          num_members: ch.num_members,
          is_private: ch.is_private,
          is_archived: ch.is_archived,
          created: ch.created,
        },
      }
    }

    case 'set_channel_topic': {
      const channel = args.channel || DEFAULT_CHANNEL
      if (!channel) throw new Error('channel required')
      const result = await slackApi('conversations.setTopic', { channel, topic: args.topic })
      return { ok: true, topic: result.channel.topic.value }
    }

    case 'set_channel_purpose': {
      const channel = args.channel || DEFAULT_CHANNEL
      if (!channel) throw new Error('channel required')
      const result = await slackApi('conversations.setPurpose', { channel, purpose: args.purpose })
      return { ok: true, purpose: result.channel.purpose.value }
    }

    case 'list_pins': {
      const channel = args.channel || DEFAULT_CHANNEL
      if (!channel) throw new Error('channel required')
      const result = await slackApi('pins.list', { channel })
      const items = (result.items || []).map((item) => ({
        type: item.type,
        created: item.created,
        created_by: item.created_by,
        ...(item.message && {
          message: { text: item.message.text, ts: item.message.ts, user: item.message.user },
        }),
        ...(item.file && {
          file: { name: item.file.name, url: item.file.url_private, mimetype: item.file.mimetype },
        }),
      }))
      return { ok: true, items }
    }

    case 'list_bookmarks': {
      const channel = args.channel || DEFAULT_CHANNEL
      if (!channel) throw new Error('channel required')
      const result = await slackApi('bookmarks.list', { channel_id: channel })
      const bookmarks = (result.bookmarks || []).map((b) => ({
        id: b.id,
        title: b.title,
        link: b.link,
        emoji: b.emoji,
        type: b.type,
        created: b.date_created,
      }))
      return { ok: true, bookmarks }
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

      const contentType = resp.headers.get('content-type') || ''
      const contentLength = parseInt(resp.headers.get('content-length') || '0', 10)
      const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')
      const MAX_INLINE_SIZE = 100 * 1024 // 100KB

      if (isText && contentLength < MAX_INLINE_SIZE) {
        const text = await resp.text()
        return { ok: true, content: text, size: text.length }
      }

      // Save to disk for large/binary files
      const { writeFileSync } = await import('fs')
      const { randomUUID } = await import('crypto')
      const urlPath = new URL(args.url).pathname
      const filename = urlPath.split('/').pop() || 'file'
      const tmpPath = `/tmp/slack_${randomUUID().slice(0, 8)}_${filename}`
      const buffer = Buffer.from(await resp.arrayBuffer())
      writeFileSync(tmpPath, buffer)
      return { ok: true, filepath: tmpPath, size: buffer.length, content_type: contentType, hint: 'Use the Read tool to view this file' }
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
      const completeBody = {
        files: [{ id: upload.file_id, title }],
        channel_id: channel,
        thread_ts,
      }
      if (args.initial_comment) completeBody.initial_comment = args.initial_comment
      await slackApi('files.completeUploadExternal', completeBody)
      return { ok: true, filename }
    }

    case 'update_message': {
      const channel = args.channel || DEFAULT_CHANNEL
      if (!channel) throw new Error('channel required')
      if (!args.ts) throw new Error('ts required')
      const body = { channel, ts: args.ts, text: args.text }
      if (args.blocks) body.blocks = args.blocks
      const result = await slackApi('chat.update', body)
      return { ok: true, ts: result.ts }
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
