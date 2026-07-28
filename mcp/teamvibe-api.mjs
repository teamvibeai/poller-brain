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

// --- schedule timestamp rendering (#240) ---
//
// Stored schedules carry bare ISO-UTC timestamps. Reading one then means converting
// UTC -> schedule timezone -> weekday in your head, with nothing to check the result
// against — which is how #145 got filed as a day-of-week bug against a schedule that
// had run correctly (the "skipped Thursday" was a Friday). These fields render what
// the server already decided, in the schedule's own timezone, weekday spelled out.
//
// Deliberately NOT a preview of upcoming runs: `nextRunAt` is computed server-side by
// cron-parser, and a locally recomputed occurrence list that disagreed with it would
// be worse than none. Rendering only, no cron evaluation, no dependencies.

const LOCAL_TIME_FIELDS = [
  ['lastRunAt', 'lastRunAtLocal'],
  ['nextRunAt', 'nextRunAtLocal'],
  ['scheduledAt', 'scheduledAtLocal'],
]

function formatLocalTime(iso, timezone) {
  if (typeof iso !== 'string' || !iso) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  const tz = timezone || 'UTC'
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
  } catch {
    return undefined // unknown IANA zone — annotate nothing rather than render a wrong offset
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} (${tz})`
}

function annotateSchedule(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  const local = {}
  for (const [source, target] of LOCAL_TIME_FIELDS) {
    const rendered = formatLocalTime(row[source], row.timezone)
    if (rendered) local[target] = rendered
  }
  if (Object.keys(local).length === 0) return row
  // Annotations first: `promptTemplate` has no length ceiling, and anything below it
  // is the first thing a truncated log drops. Original fields keep their exact values.
  return { ...local, ...row }
}

// Build the delivery-target hint echoed back to the agent so it can verify a
// scheduled message will reach the intended recipient. origin.channel is frozen
// at create time and replayed every run; when it is inherited from the current
// session it may be a DM or a different channel than intended (poller-brain#124).
function buildDeliveryInfo(origin, wasExplicit) {
  const channel = origin?.channel || null
  return {
    channel,
    thread_ts: origin?.thread_ts || null,
    resolvedFrom: wasExplicit
      ? 'explicit-origin'
      : channel
        ? 'inherited-from-current-session'
        : 'none',
    note: channel
      ? wasExplicit
        ? `Delivery channel ${channel} (explicit).`
        : `Delivery channel ${channel} was inherited from the CURRENT session. If this schedule is meant for a different channel/recipient, re-create it with an explicit origin.channel.`
      : 'No origin.channel resolved — runs fall back to the channel default target.',
  }
}

// Assembles the create_scheduled_message response. `delivery` goes ahead of
// everything else: `annotateSchedule` already puts the rendered *Local fields
// ahead of the raw row for the same reason (promptTemplate has no length
// ceiling, and the poller truncates a logged tool_result at 200 chars —
// claude-spawner.ts truncateOutput). Behind the row, delivery would never
// reach the session log. Short/telemetry fields up, echoes down (#184).
function buildScheduleResponse(result, storedOrigin, wasExplicit) {
  // Our block is authoritative — drop a server-side `delivery` rather than let
  // the spread reinstate it further down the object under the same name.
  const { delivery: _serverDelivery, ...row } =
    result && typeof result === 'object' ? result : { result }
  return { delivery: buildDeliveryInfo(storedOrigin, wasExplicit), ...annotateSchedule(row) }
}

const TOOLS = [
  {
    name: 'list_scheduled_messages',
    description: 'List scheduled messages for the current workspace/channel. Returns all schedules with their status, cron expression, and next run time. Run timestamps are ISO-UTC; the matching *Local fields render them in the schedule timezone with the weekday — read those before concluding a schedule misfired.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Filter by channel ID (default: current channel)' },
      },
    },
  },
  {
    name: 'create_scheduled_message',
    description: 'Create or update a scheduled message. For recurring schedules use CRON type with a cron expression. For one-time schedules use ONE_TIME type with scheduledAt. The response echoes the stored row including nextRunAt and nextRunAtLocal (schedule timezone + weekday) — check it fires when you intended.',
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
          description: 'Origin context for response routing — which Slack channel/thread the scheduled run delivers to. Auto-populated from the CURRENT session Slack channel if omitted, and FROZEN at create time (replayed on every run). Pass explicitly (esp. origin.channel) when the schedule targets a different channel/recipient than this session — e.g. scheduling from a DM for a project channel.',
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
      const result = await apiCall('GET', `/scheduled-messages?${params}`)
      if (!Array.isArray(result?.items)) return result
      return { ...result, items: result.items.map(annotateSchedule) }
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

      // Auto-populate origin from environment if not explicitly provided.
      // NOTE: origin.channel is FROZEN onto the schedule at create time and
      // replayed on every run. When inherited here it is THIS session's Slack
      // channel — which may be a DM or a different channel than the schedule is
      // meant for (see poller-brain#124).
      if (args.origin) {
        body.origin = args.origin
      } else if (process.env.SLACK_CHANNEL) {
        body.origin = {
          source: 'slack',
          channel: process.env.SLACK_CHANNEL,
          thread_ts: process.env.SLACK_THREAD_TS || undefined,
        }
      }

      const result = await apiCall('POST', '/scheduled-messages', body)

      // Surface the resolved delivery target so the agent can verify it matches
      // the intended recipient before trusting the schedule (poller-brain#124, option B).
      // Prefer the origin the server actually STORED (ground truth) over the one we
      // sent, so the block stays honest if the platform ever normalizes origin
      // server-side (e.g. option C) — fall back to body.origin when not echoed.
      const storedOrigin = (result && typeof result === 'object' && result.origin) || body.origin
      return buildScheduleResponse(result, storedOrigin, Boolean(args.origin))
    }

    case 'delete_scheduled_message': {
      const params = new URLSearchParams({ workspaceId: WORKSPACE_ID })
      return await apiCall('DELETE', `/scheduled-messages/${args.scheduleId}?${params}`)
    }

    case 'submit_feedback': {
      return await apiCall('POST', '/feedback', {
        channelId: CHANNEL_ID,
        type: args.type,
        priority: args.priority,
        context: args.context,
      })
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
