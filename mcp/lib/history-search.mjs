// Poller-owned schema v1. This module never creates or modifies an index.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const loadSqlite = () => require('node:sqlite').DatabaseSync
export const historyGuardCache = new Map()

const denied = error => ({ ok: false, error })

/** Read one channel from a poller-local index; dependencies are injectable. */
export function searchHistory({ storagePath, channelId, slackChannel, query, limit = 20 }, deps = {}) {
  limit = Math.max(1, Math.min(100, limit))
  const empty = note => ({ ok: true, channel: slackChannel, count: 0, limit, results: [], note })
  const terms = query.normalize('NFC').match(/[\p{L}\p{N}_]+/gu) ?? []
  if (!terms.length) return empty('empty_query')

  let db
  try {
    if (!storagePath || !channelId) return empty('no_history')
    // The TeamVibe channel selects a filename; the Slack channel is a SQL key.
    if (!/^[a-zA-Z0-9_-]+$/.test(channelId)) return denied('index_unavailable')
    const path = join(storagePath, 'history', `${channelId}.sqlite`)
    if (!fs.existsSync(path)) return empty('no_history')
    const Sqlite = (deps.loadSqlite ?? loadSqlite)()
    const deadline = performance.now() + 2000
    // Verified on Node 22: readOnly is honoured, so no query_only fallback.
    db = new Sqlite(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) return denied('index_unavailable')
    // SQLite can retry internally beyond a single busy interval on Node 22/25.
    // Fail closed if it returns after our contention budget has expired.
    if (performance.now() >= deadline) return denied('index_unavailable')
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    const rows = db.prepare(`SELECT m.ts, m.thread_ts, m.user_id, m.author, m.text, m.attachment_names, m.source, m.updated_at
      FROM history h JOIN messages m ON m.rowid = h.rowid
      WHERE history MATCH ? AND m.channel = ? AND m.deleted = 0
      ORDER BY bm25(history) LIMIT ?`).all(match, slackChannel, limit)
    if (performance.now() >= deadline) return denied('index_unavailable')
    const results = rows.map(row => ({
      ts: row.ts, thread_ts: row.thread_ts, user_id: row.user_id, author: row.author,
      text: row.text, attachment_names: row.attachment_names ? row.attachment_names.split('\n') : [],
      source: row.source, updated_at: row.updated_at,
    }))
    return { ok: true, channel: slackChannel, count: results.length, limit, results }
  } catch {
    return denied('index_unavailable')
  } finally {
    try { db?.close() } catch { /* Never expose SQLite diagnostics. */ }
  }
}

/** Own-channel deliveries are already authorized. Other channels fail closed. */
export async function guardHistoryChannel({ channel, sessionChannel, token, brainPath, threadId }, deps = {}) {
  if (channel === sessionChannel) return { ok: true }
  if (!token) return denied('channel_not_accessible')

  let requester
  try {
    if (threadId) {
      const context = JSON.parse((deps.fs ?? fs).readFileSync(
        join(brainPath || process.cwd(), '.inbox', threadId, 'context.json'), 'utf8'))
      if (typeof context?.sender?.id === 'string' && /^[UW][A-Z0-9]{5,}$/.test(context.sender.id)) requester = context.sender.id
    }
  } catch { /* Resolve failures only after step A, preserving its error code. */ }
  const cache = deps.cache ?? historyGuardCache
  const key = JSON.stringify([channel, requester])
  if (requester && cache.get(key) === true) return { ok: true }

  const slack = async (method, params) => {
    const response = await (deps.fetch ?? globalThis.fetch)(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ channel, ...params }).toString(),
    })
    if (response.ok !== true) throw new Error()
    const body = await response.json()
    if (body?.ok !== true) throw new Error()
    return body
  }

  // A: bot access. DMs have is_im but no is_member.
  try {
    const { channel: info } = await slack('conversations.info')
    if (!(info?.is_im === true || info?.is_mpim === true || info?.is_member === true)) return denied('channel_not_accessible')
  } catch { return denied('channel_not_accessible') }

  // B: the human who woke this session must also be a member.
  if (!requester) return denied('requester_unresolved')
  try {
    let cursor = ''
    for (let page = 0; page < 20; page++) {
      const body = await slack('conversations.members', { limit: '200', ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(body.members)) return denied('membership_unverified')
      if (body.members.includes(requester)) {
        cache.set(key, true)
        return { ok: true }
      }
      cursor = body.response_metadata?.next_cursor ?? ''
      if (typeof cursor !== 'string') return denied('membership_unverified')
      cursor = cursor.trim()
      if (!cursor) return denied('not_a_member')
    }
  } catch { /* API errors and diagnostics never escape. */ }
  return denied('membership_unverified')
}
