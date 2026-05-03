#!/usr/bin/env node
/**
 * TeamVibe API MCP Server — scheduled messages & agent feedback.
 *
 * Environment variables (set by claude-spawner):
 *   TEAMVIBE_API_URL      — Poller API base URL
 *   TEAMVIBE_POLLER_TOKEN — Poller auth token
 *   TEAMVIBE_WORKSPACE_ID — Current workspace ID
 *   TEAMVIBE_CHANNEL_ID   — Current TeamVibe channel ID
 */

import { createInterface } from 'readline'

const API_URL = process.env.TEAMVIBE_API_URL
const TOKEN = process.env.TEAMVIBE_POLLER_TOKEN
const WORKSPACE_ID = process.env.TEAMVIBE_WORKSPACE_ID
const CHANNEL_ID = process.env.TEAMVIBE_CHANNEL_ID

async function apiCall(method, path, body) {
  const url = `${API_URL}${path}`
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  }
  const opts = { method, headers }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(url, opts)
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`)
  return data
}

const TOOLS = [
  {
    name: 'list_scheduled_messages',
    description: 'List scheduled messages for the current workspace/channel. Returns all schedules with their status, cron expression, and next run time.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Filter by channel ID (default: current channel)' },
      },
    },
  },
  {
    name: 'create_scheduled_message',
    description: 'Create or update a scheduled message. For recurring schedules use CRON type with a cron expression. For one-time schedules use ONE_TIME type with scheduledAt.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: 'Schedule ID to update (omit to create new)' },
        scheduleType: { type: 'string', enum: ['CRON', 'ONE_TIME'], description: 'CRON for recurring, ONE_TIME for single execution' },
        cronExpression: { type: 'string', description: 'Cron expression for recurring schedules (e.g., "0 9 * * 1-5" for weekdays at 9am)' },
        scheduledAt: { type: 'string', description: 'ISO datetime for one-time schedules (e.g., "2026-03-15T09:00:00Z")' },
        endDate: { type: 'string', description: 'Optional end date for recurring schedules (ISO datetime)' },
        timezone: { type: 'string', description: 'IANA timezone (default: UTC). Examples: Europe/Prague, America/New_York' },
        promptTemplate: { type: 'string', description: 'The prompt/instruction that will be executed at the scheduled time' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'], description: 'Schedule status (default: ACTIVE)' },
        origin: {
          type: 'object',
          description: 'Origin context for response routing. Auto-populated from Slack env vars if not provided.',
          properties: {
            source: { type: 'string', enum: ['slack', 'heartbeat', 'email', 'api'] },
            channel: { type: 'string' },
            thread_ts: { type: 'string' },
            from: { type: 'string' },
            subject: { type: 'string' },
          },
        },
      },
      required: ['promptTemplate'],
    },
  },
  {
    name: 'delete_scheduled_message',
    description: 'Delete a scheduled message by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: 'The schedule ID to delete' },
      },
      required: ['scheduleId'],
    },
  },
  {
    name: 'submit_feedback',
    description: 'Submit feedback about the platform (bugs, improvements, observations). Feedback is stored in a central database and consolidated by the eval pipeline. Use when a user explicitly reports an issue or when you observe a platform problem worth tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['bug', 'improvement', 'observation'],
          description: 'Type of feedback',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'How critical the agent considers this feedback',
        },
        context: {
          type: 'string',
          description: 'Description of the feedback (minimum 10 characters)',
        },
        targetRepo: {
          type: 'string',
          enum: ['teamvibeai/teamvibe.ai', 'teamvibeai/poller-brain', 'teamvibeai/poller-brain-eval'],
          description: 'Target repository (optional)',
        },
      },
      required: ['type', 'priority', 'context'],
    },
  },
]

async function handleTool(name, args) {
  if (!API_URL || !TOKEN) throw new Error('TeamVibe API not configured')

  switch (name) {
    case 'list_scheduled_messages': {
      const channelId = args.channelId || CHANNEL_ID
      const params = new URLSearchParams({ workspaceId: WORKSPACE_ID })
      if (channelId) params.set('channelId', channelId)
      return await apiCall('GET', `/scheduled-messages?${params}`)
    }

    case 'create_scheduled_message': {
      const body = {
        workspaceId: WORKSPACE_ID,
        channelId: CHANNEL_ID,
        scheduleType: args.scheduleType || 'CRON',
        promptTemplate: args.promptTemplate,
      }
      if (args.scheduleId) body.scheduleId = args.scheduleId
      if (args.cronExpression) body.cronExpression = args.cronExpression
      if (args.scheduledAt) body.scheduledAt = args.scheduledAt
      if (args.endDate) body.endDate = args.endDate
      if (args.timezone) body.timezone = args.timezone
      if (args.status) body.status = args.status

      // Auto-populate origin from environment if not explicitly provided
      if (args.origin) {
        body.origin = args.origin
      } else if (process.env.SLACK_CHANNEL) {
        body.origin = {
          source: 'slack',
          channel: process.env.SLACK_CHANNEL,
          thread_ts: process.env.SLACK_THREAD_TS || undefined,
        }
      }

      return await apiCall('POST', '/scheduled-messages', body)
    }

    case 'delete_scheduled_message': {
      const params = new URLSearchParams({ workspaceId: WORKSPACE_ID })
      return await apiCall('DELETE', `/scheduled-messages/${args.scheduleId}?${params}`)
    }

    case 'submit_feedback': {
      const body = {
        channelId: CHANNEL_ID,
        type: args.type,
        priority: args.priority,
        context: args.context,
      }
      if (args.targetRepo) body.targetRepo = args.targetRepo
      return await apiCall('POST', '/feedback', body)
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
        serverInfo: { name: 'teamvibe-api', version: '1.0.0' },
      })

    case 'notifications/initialized':
      return null

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
      if (id === undefined) return null
      return jsonrpcError(id, -32601, `Method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', async (line) => {
  if (!line.trim()) return
  try {
    const req = JSON.parse(line)
    const response = await handleRequest(req)
    if (response) process.stdout.write(response + '\n')
  } catch (e) {
    process.stdout.write(jsonrpcError(null, -32700, `Parse error: ${e.message}`) + '\n')
  }
})

rl.on('close', () => process.exit(0))
