#!/usr/bin/env node
/**
 * Slack MCP Server — zero-dependency MCP server for Slack communication.
 * Implements JSON-RPC 2.0 over stdio using only Node.js built-ins + fetch().
 *
 * Environment variables (set by claude-spawner):
 *   SLACK_BOT_TOKEN          — Slack bot OAuth token
 *   SLACK_CHANNEL            — Default channel ID
 *   SLACK_THREAD_TS          — Default thread timestamp
 *   SLACK_MESSAGE_TS         — Original message timestamp (for reactions)
 *   TEAMVIBE_AGENT_BOT_IDS   — Optional comma-separated Slack user IDs of OTHER
 *                              registered TeamVibe agent bots. Used to gate the
 *                              `missing_recipient_tag` warning so that only real
 *                              agents (not integration webhooks like GitHub,
 *                              USLACKBOT, etc.) trigger it. When unset, all bot
 *                              messages count as eligible speakers (degraded but
 *                              non-blocking).
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

const SYSTEM_BOT_IDS = new Set(['USLACKBOT'])
const AGENT_BOT_IDS = new Set(
  (process.env.TEAMVIBE_AGENT_BOT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

// --- Slack API helper ---

// Slack hides the `text` field of chat.postMessage when `blocks` are present
// (text becomes notification/accessibility fallback only). To keep the text
// visible alongside blocks, prepend it as section block(s). Section text has
// a 3000-char limit, so we chunk at newline boundaries (hard-cut as last resort).
function textToSections(text, maxLen = 2900) {
  const sections = []
  let remaining = text
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen)
    if (cut <= 0) cut = maxLen
    sections.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, cut) } })
    remaining = remaining.slice(cut).replace(/^\n/, '')
  }
  if (remaining) {
    sections.push({ type: 'section', text: { type: 'mrkdwn', text: remaining } })
  }
  return sections
}

// Per Slack's docs, most WRITE methods accept a JSON body; READ/list methods are the
// risk class — some (chat.getPermalink, pins.list) reject JSON outright and report
// arguments as missing no matter what's sent, others (bookmarks.list) don't. There's no
// clean rule to predict which; each entry below was confirmed by an actual failing call
// (poller-brain#345). Before adding a new read/list method to either branch, probe it
// live rather than assuming by analogy. pins.add/pins.remove live-probed 2026-08-19
// (poller-brain#315, DevGuru): both content types return message_not_found on a bogus
// timestamp (not invalid_arguments), confirming the JSON body parses — WRITE-method
// default holds, no exception needed.
function needsFormEncoding(method) {
  return method.startsWith('conversations.') || method.startsWith('files.') || method === 'chat.getPermalink' || method === 'pins.list'
}

async function slackApi(method, body) {
  const useForm = needsFormEncoding(method)
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

// --- Thread/channel helpers (used by send_message warning + list_thread_participants) ---

// conversations.info results are stable for the session — cache to avoid repeat calls.
const _channelInfoCache = new Map()
async function getChannelKind(channel) {
  if (!channel) return 'channel'
  if (_channelInfoCache.has(channel)) return _channelInfoCache.get(channel)
  try {
    const result = await slackApi('conversations.info', { channel })
    const ch = result.channel || {}
    const kind = ch.is_im ? 'im' : ch.is_mpim ? 'mpim' : ch.is_group ? 'group' : 'channel'
    _channelInfoCache.set(channel, kind)
    return kind
  } catch {
    return 'channel' // best-effort default = most permissive (warning may fire)
  }
}

// Resolve own bot identity via auth.test. The TEAMVIBE_BOT_ID env var holds
// the bot API id (Bxxx prefix) — useful for platform API calls but NOT for
// matching against `m.user` (Uxxx prefix) in Slack message payloads. We need
// both: user_id matches m.user, bot_id matches m.bot_id. Cached for session
// lifetime (auth.test result doesn't change mid-session).
let _selfIdsCache = null
async function resolveSelfIds() {
  if (_selfIdsCache) return _selfIdsCache
  try {
    const result = await slackApi('auth.test', {})
    _selfIdsCache = {
      user_id: result.user_id || null, // Uxxx — matches m.user
      bot_id: result.bot_id || BOT_ID || null, // Bxxx — matches m.bot_id
    }
  } catch {
    _selfIdsCache = { user_id: null, bot_id: BOT_ID || null }
  }
  return _selfIdsCache
}

// True if message m is an eligible "non-self speaker" for the tag warning:
// - is a regular user message or a bot_message (not channel_join, file_share comment, etc.)
// - is not us (checked against both user_id and bot_id — apps use either field)
// - is not the just-sent message (excludeTs guard against race)
// - is not USLACKBOT or other system bots
// - if it's a bot, either AGENT_BOT_IDS is empty (degraded mode) or this user is in it
function isEligibleSpeaker(m, self, excludeTs) {
  if (!m || !m.user) return false
  if (m.subtype && m.subtype !== 'bot_message') return false
  if (self && self.user_id && m.user === self.user_id) return false
  if (self && self.bot_id && m.bot_id && m.bot_id === self.bot_id) return false
  if (excludeTs && m.ts === excludeTs) return false
  if (SYSTEM_BOT_IDS.has(m.user)) return false
  if (m.bot_id && AGENT_BOT_IDS.size > 0 && !AGENT_BOT_IDS.has(m.user)) return false
  return true
}

async function getLastEligibleSpeaker(channel, threadTs, excludeTs = null) {
  if (!channel || !threadTs) return null
  const self = await resolveSelfIds()
  try {
    const result = await slackApi('conversations.replies', { channel, ts: threadTs, limit: 50 })
    const msgs = result.messages || []
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (isEligibleSpeaker(msgs[i], self, excludeTs)) return msgs[i].user
    }
    return null
  } catch {
    return null // best-effort — never fail send_message on warning detection
  }
}

// Returns a warning hint object if outgoing reply in a multi-party thread is
// missing the recipient tag, or null. Gate: only mpim/channel/group (no 1:1 DM).
// Deterministic — no time threshold, no LLM. See teamvibeai/teamvibe.ai#108.
// justSentTs (optional) lets the caller pass the ts of the message we just
// posted, so we exclude it from the lookback — eliminating the "self appears
// as last speaker" race when warning eval runs after chat.postMessage.
async function computeMissingTagWarning(channel, threadTs, text, justSentTs = null) {
  if (!channel || !threadTs) return null
  const kind = await getChannelKind(channel)
  if (kind === 'im') return null
  const lastSpeaker = await getLastEligibleSpeaker(channel, threadTs, justSentTs)
  if (!lastSpeaker) return null
  if (text && text.includes(`<@${lastSpeaker}>`)) return null
  return {
    code: 'missing_recipient_tag',
    detail: `Last message in this thread is from <@${lastSpeaker}>, but your reply does not tag them. They will not be notified (other agents stay asleep without a mention; humans often miss thread replies they're not tagged in). Add the tag in a follow-up, or ignore this warning if the omission is intentional (broadcast / status update).`,
    last_speaker_id: lastSpeaker,
  }
}

// --- thread_ts override guardrail (teamvibeai/teamvibe.ai#184, phase 1) ---
//
// Measurement rail for phase 3: the `warning_codes` field of the response. The
// poller already logs every tool_result into the session log (claude-spawner.ts
// formatStreamEvent → sessionLog.claude('stdout', …)), so counting occurrences
// of a warning code needs no new plumbing. A stderr marker from this file
// would NOT work — the poller captures the claude CLI's stderr, not an MCP
// child's, so it would be a silent-green counter (DevGuru review #1).
//
// Two codes, deliberately: `thread_ts_override_unjustified` (signals A and C
// both fired) and `thread_ts_override_unverified` (A fired, C unreadable). A
// silent third case would make "we could not tell" indistinguishable from
// "nothing happened" and would bias phase 3 toward a false all-clear.

// "Did the user point at this thread?" — three forms count, because an archive
// URL carries the *message* ts in its `p<ts>` path segment and the thread ts
// only in the `?thread_ts=` query param (DevGuru review #3):
//   1. raw ts pasted in the text            → 1780637428.794809
//   2. `?thread_ts=` on a reply permalink   → also the raw ts, same check
//   3. thread-parent permalink path segment → p1780637428794809
function referencesThreadTs(text, threadTs) {
  if (!text || !threadTs) return false
  const ts = String(threadTs).trim()
  if (!ts) return false
  return text.includes(ts) || text.includes(`p${ts.replace('.', '')}`)
}

// Pure decision for the `thread_ts_override_unjustified` warning. No I/O, no
// LLM — the caller supplies the triggering user message text.
//
// Phase 1 implements signal A (explicit target ≠ session current thread) and
// signal C (triggering message does not reference the target). Signal B
// (target is among the last N wake sources) needs a per-channel wake ledger,
// which is a new DDB access pattern — deferred to phase 3, see the issue.
// Consequence: an agent-to-agent handoff back into a recently-woken thread
// warns even though it is legitimate. The detail text says so explicitly.
//
// triggerText === null means "could not be determined" and MUST be resolved by
// the caller before deciding — this function treats it as "no reference".
function computeThreadOverrideWarning({ explicitThreadTs, sessionThreadTs, triggerText }) {
  // Gate: only an explicitly passed thread_ts can be an override. Omitting it
  // is the documented default and always routes to the session thread.
  if (explicitThreadTs === undefined) return null
  // Exception 4: `thread_ts: null` is the documented top-level broadcast.
  if (explicitThreadTs === null) return null
  // Exception 1: no session thread at all — scheduled message with its own
  // target, or a cold start with no thread context. Nothing to deviate from.
  if (!sessionThreadTs) return null
  // Signal A is an exact match, so normalize both sides first: a stray space or
  // a numeric ts would otherwise read as a foreign thread (DevGuru review #2).
  const target = String(explicitThreadTs).trim()
  const session = String(sessionThreadTs).trim()
  if (!target || !session) return null
  if (target === session) return null
  // Signal C / exception 2: the user's own message points at the target thread
  // (raw ts or permalink) — that is a cross-thread handoff they asked for.
  if (referencesThreadTs(triggerText, target)) return null
  return {
    code: 'thread_ts_override_unjustified',
    detail:
      `You passed thread_ts=${target}, but this session's current thread is ${session}, ` +
      `and the message that woke you does not reference ${target}. The reply landed in a thread the ` +
      `user may not be reading. If that was unintentional, delete it with chat.delete(ts) and re-send without ` +
      `thread_ts. Ignore this warning if the override was deliberate — a handoff into a thread you were recently ` +
      `woken from is legitimate and is not yet detected here.`,
    session_thread_ts: session,
    override_thread_ts: target,
  }
}

// Fetches the text of the message that woke this session, so signal C can be
// evaluated. Returns '' for a genuinely empty message and null when the text
// could not be determined (API failure, message not in the thread) — the two
// cases must not collapse, see resolveThreadOverrideWarning.
//
// Windowed with `latest`/`inclusive` rather than a plain `limit`, so the fetch
// asks for exactly the one message it needs instead of leaning on how Slack
// pages a thread. (Measured: `limit: N` returns the parent plus the N *newest*
// replies, so a plain limit would in fact have found the trigger message — but
// that direction is not in the docs and is not worth depending on.)
async function getTriggerMessageText(channel, threadTs, messageTs) {
  if (!channel || !threadTs || !messageTs) return null
  try {
    const result = await slackApi('conversations.replies', {
      channel,
      ts: threadTs,
      latest: messageTs,
      inclusive: true,
      limit: 1,
    })
    const msg = (result.messages || []).find((m) => m.ts === messageTs)
    return msg ? msg.text || '' : null
  } catch {
    return null // best-effort — never fail send_message on warning detection
  }
}

// Emitted when an override is real (signal A fired) but signal C could not be
// evaluated: the trigger message was unreachable. Without it, "override we
// could not verify" and "no override at all" look identical in the session log,
// and phase 3 would count a zero and read it as a low false-positive rate
// (DevGuru diff-check #3). This gives that measurement a denominator.
function unverifiedOverrideWarning(session, target) {
  return {
    code: 'thread_ts_override_unverified',
    detail:
      `You passed thread_ts=${target} while this session's thread is ${session}. Could not read the ` +
      `message that woke you, so whether you were asked to post there is unknown. Check the target thread is right.`,
    session_thread_ts: session,
    override_thread_ts: target,
  }
}

async function resolveThreadOverrideWarning(explicitThreadTs, sessionThreadTs) {
  // Cheap pure gates first: no Slack API call unless a real override is on the
  // table (triggerText: null here only defers the signal C check).
  const provisional = computeThreadOverrideWarning({
    explicitThreadTs,
    sessionThreadTs,
    triggerText: null,
  })
  if (!provisional) return null
  // DEFAULT_CHANNEL, not the message's target channel: the session thread and
  // the message that woke us live in the channel we were woken from. Reading
  // the target channel made the guardrail silent on cross-channel posts —
  // exactly where a misrouted reply is most expensive (DevGuru diff-check #2).
  const triggerText = await getTriggerMessageText(DEFAULT_CHANNEL, sessionThreadTs, DEFAULT_MESSAGE_TS)
  if (triggerText === null) {
    return unverifiedOverrideWarning(provisional.session_thread_ts, provisional.override_thread_ts)
  }
  return computeThreadOverrideWarning({ explicitThreadTs, sessionThreadTs, triggerText })
}

// Single source of truth for "is this a pipe-table row?" — shared by the
// detection gate (computePipeTableWarning) and the auto-convert splitter
// (convertPipeTablesToBlocks) so the two can never disagree on what a table
// line is. See teamvibeai/teamvibe.ai#228.
function isTableLine(line) {
  return /^\s*\|.*\|.*$/.test(line)
}

// Returns a warning hint object if outgoing `text` contains a markdown pipe
// table (2+ consecutive `^\s*\|.*\|.*$` lines), or null. Slack renders pipe
// tables in the `text` field as monospace ASCII without column alignment;
// `blocks: [{type: 'markdown', ...}]` renders them correctly.
// Deterministic — no LLM, no API call. See teamvibeai/teamvibe.ai#224.
function computePipeTableWarning(text) {
  if (!text || typeof text !== 'string') return null
  // Strip triple-fenced code blocks — pipe-tables inside fences are quoted
  // material (instructions, samples), not table rendering.
  const stripped = text.replace(/```[\s\S]*?```/g, '')
  const lines = stripped.split('\n')
  let consecutive = 0
  for (const line of lines) {
    if (isTableLine(line)) {
      consecutive++
      if (consecutive >= 2) {
        return {
          code: 'ascii_table_in_text',
          detail: "Detected markdown table syntax in `text` field. Slack renders pipe tables as monospace ASCII without column alignment. Use a `markdown` block via `blocks: [{type: 'markdown', text: '...'}]` for proper rendering.",
        }
      }
    } else {
      consecutive = 0
    }
  }
  return null
}

// Convert GFM inline syntax to Slack mrkdwn for PROSE segments only (never
// tables — those go raw into a `markdown` block). Covers the cases DevGuru
// flagged: **bold**/__bold__ → *bold*, [label](url) → <url|label>,
// ~~strike~~ → ~strike~. Italics via _x_ are already valid mrkdwn.
// See teamvibeai/teamvibe.ai#228.
// Known limits (documented, non-blocking — see #206 review): normalization is
// not code-span/fence aware (markers inside `inline code` are still converted —
// rare in prose), link URLs containing `)` (wiki-style `.../Foo_(bar)`) are not
// matched, and `***bold-italic***` triple-star is out of scope. These degrade
// to the literal marker, never to broken rendering.
function gfmInlineToMrkdwn(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    .replace(/\*\*([^*]+?)\*\*/g, '*$1*')
    .replace(/__([^_]+?)__/g, '*$1*')
    .replace(/~~([^~]+?)~~/g, '~$1~')
}

// Undo HTML-entity escaping (&lt;@U..&gt; etc.) agents sometimes produce after
// reading HTML-escaped context (e.g. thread history), which otherwise renders
// as literal text instead of a mention/link and silently drops the ping.
// Safe in one direction only: Slack's `text` field has its own (different)
// escaping rules and never relies on these HTML sequences meaning anything.
// Fenced code blocks and inline code spans are left untouched (same fence
// convention as computePipeTableWarning) — an escaped mention QUOTED as a
// code example (e.g. a bug report citing `&lt;@U..&gt;`, like this file's own
// review thread) must not silently become a live ping. A single alternation
// pass — rather than three sequential .replace() calls — naturally decodes
// each occurrence once (leftmost match wins), so "&amp;lt;" resolves to the
// literal "&lt;" instead of cascading into "<". See teamvibeai/poller-brain#243.
function normalizeHtmlEntities(text) {
  return text.replace(/(```[\s\S]*?```|`[^`\n]*`)|(&lt;|&gt;|&amp;)/g, (m, code, entity) => {
    if (code) return code
    return entity === '&lt;' ? '<' : entity === '&gt;' ? '>' : '&'
  })
}

// Auto-convert (teamvibeai/teamvibe.ai#228, Variant B): split `text` into
// prose + pipe-table segments IN ORDER, render prose as section(mrkdwn) blocks
// and each table as a raw `markdown` block. Returns { blocks, fallbackText,
// transformed } — or null if no real table run was produced, so the caller
// keeps existing behavior (eliminates any gate/splitter mismatch — the convert
// only "takes" when it actually built a table block). Uses isTableLine, the
// SAME predicate as the detection gate. Fenced code (```) is treated as prose
// so literal pipe-tables inside fences stay verbatim.
function convertPipeTablesToBlocks(text) {
  const lines = text.split('\n')
  // 1) mark each line: table-candidate (pipe row outside a fence) vs prose
  let inFence = false
  const marks = lines.map((l) => {
    if (/^\s*```/.test(l)) {
      inFence = !inFence
      return 'prose'
    }
    return !inFence && isTableLine(l) ? 'tc' : 'prose'
  })
  // 2) a real table needs >=2 consecutive rows (matches the gate); downgrade
  //    isolated single pipe-rows back to prose
  for (let i = 0; i < marks.length; ) {
    if (marks[i] === 'tc') {
      let j = i
      while (j < marks.length && marks[j] === 'tc') j++
      const kind = j - i >= 2 ? 'table' : 'prose'
      for (let k = i; k < j; k++) marks[k] = kind
      i = j
    } else i++
  }
  // 3) group contiguous same-kind lines into ordered segments
  const segments = []
  for (let i = 0; i < lines.length; i++) {
    const kind = marks[i] === 'table' ? 'table' : 'prose'
    const last = segments[segments.length - 1]
    if (last && last.kind === kind) last.lines.push(lines[i])
    else segments.push({ kind, lines: [lines[i]] })
  }
  // 4) build blocks + verbatim-prose fallback
  const blocks = []
  const proseParts = []
  for (const seg of segments) {
    if (seg.kind === 'table') {
      blocks.push({ type: 'markdown', text: seg.lines.join('\n').trim() })
    } else {
      const raw = seg.lines.join('\n').replace(/^\n+|\n+$/g, '').trim()
      if (!raw) continue
      proseParts.push(raw)
      for (const s of textToSections(gfmInlineToMrkdwn(raw))) blocks.push(s)
    }
  }
  if (!blocks.some((b) => b.type === 'markdown')) return null // no table → passthrough
  // Verbatim prose is the notification fallback (mentions preserved → ping
  // survives). Table-only messages have no prose → never let top-level text be
  // empty (that reintroduces the empty-preview problem, tv.ai#108).
  let fallbackText = proseParts.join(' ').replace(/\s+/g, ' ').trim()
  if (!fallbackText) fallbackText = ':bar_chart: Tabulka'
  return {
    blocks,
    fallbackText,
    transformed: {
      reason: 'pipe_table_in_text',
      table_moved_to: 'markdown_block',
      fallback_text: fallbackText,
    },
  }
}

// Assembles the send_message response. Key insertion order is load-bearing:
// JSON.stringify emits keys in insertion order, and the poller truncates a
// logged tool_result at 200 chars (claude-spawner.ts truncateOutput), so
// anything unbounded placed earlier can push later keys out of the session log.
// `warning_codes` therefore goes ahead of `transformed`, whose `fallback_text`
// is the message's whole prose and can be arbitrarily long (DevGuru diff-check).
// The session log is the measurement rail for #184 phase 3 and for the #108
// counting that predates it; neither should depend on message length.
function buildSendResponse({ ts, transformed, warnings }) {
  const finalWarnings = (warnings || []).filter(Boolean)
  const response = { ok: true, ts }
  if (finalWarnings.length) response.warning_codes = finalWarnings.map((w) => w.code)
  if (transformed) response.transformed = transformed
  if (finalWarnings.length) response.warnings = finalWarnings
  return response
}

// Repairs a bare URL wrapped in single-asterisk bold where the ENTIRE bold
// span is just the URL (poller-brain#225). Root cause (empirically confirmed
// against live Slack rendering): Slack's autolinker finds the `http(s)://`
// start fine, so the leading `*` is stranded as literal text, but it scans
// forward for the URL's end until whitespace — `*` isn't a stop character, so
// the trailing `*` gets swallowed into the href and corrupts it. A bare URL
// (no adjacent markers) already renders correctly, so stripping both
// asterisks is sufficient — no need to re-wrap as an explicit `<url>` link.
// Deliberately narrow: only the `*...*` marker (not `_..._`/`~...~`), and only
// when the bold span contains NOTHING but the URL — a bold sentence that
// merely mentions a URL (`*see https://x for details*`) is untouched, since
// there's no evidence that pattern hits the same adjacency bug and it's a far
// more common, riskier span to alter.
function stripBoldWrappedUrl(text) {
  return text.replace(/(^|\s)\*(https?:\/\/[^\s*]+)\*(?=\s|$)/g, '$1$2')
}

// Repairs the distinct gap from #225 (poller-brain#322): a bare URL sitting
// mid-sentence inside a `*...*` bold span, immediately before the closing
// `*`, where the span also contains OTHER text (`*testovat můžeš na
// https://x*`). Same Slack-autolinker adjacency bug as #225 — `*` isn't a
// stop character, so it gets swallowed into the href — but here stripping
// the markers (the #225 fix) would also destroy the sentence's intended bold
// formatting, which #225 deliberately left alone for exactly this shape. Fix:
// wrap only the URL itself in explicit `<url>` link syntax, so the character
// immediately before the closing `*` becomes `>` instead of a URL char — the
// bold span, the link, and the closing `*` all render correctly this way
// (empirically verified against live Slack rendering, poller-brain#322
// thread, same verification bar #225 set).
// Requires a real opening `(^|\s)\*` anchor (mirrors #225's own anchor) —
// an earlier draft matched ANY "URL immediately followed by word-boundary
// `*`", with no requirement that it sit inside an actual bold span. DevGuru
// measured 3 live false positives from that: a Cloudflare route glob ending
// `/*` (common in this workspace, already `<url>`-wrapped by the author —
// the internal `*` isn't a bold marker at all), the same shape inside a
// ` ``` ` code fence (mutating content meant to be copied/run), and a plain
// prose URL with a literal trailing `*`. The anchor requires an actual
// unmatched opening `*` before the URL, which none of those have, so they're
// no longer touched.
// Trailing punctuation (`.,;:!?`) is captured separately and placed AFTER
// the closing `>` rather than inside it — `<url>`'s href isn't heuristically
// trimmed by Slack's autolinker the way a bare URL's is (DevGuru measured
// `<https://example.com/y.>` swallowing the period into the href live), so a
// bold sentence ending "...https://x/a." would otherwise ship a broken link.
// Runs AFTER stripBoldWrappedUrl so the two never double-match the same span:
// the solo-url case already has its asterisks removed by the time this runs,
// so there's no trailing `*` left for this regex to find.
// Deliberately narrow like #225: only `*` (not `_..._`/`~...~`) — no evidence
// yet the same adjacency bug hits those markers; extend if/when reported.
function wrapBoldEmbeddedUrl(text) {
  return text.replace(
    /(^|\s)\*([^*\n]*\s)(https?:\/\/[^\s*<>]*[^\s*<>.,;:!?])([.,;:!?]*)\*(?=\s|$)/g,
    '$1*$2<$3>$4*'
  )
}

// Pure payload builder for send_message: decides final blocks / effective text /
// transform echo BEFORE any network I/O, so the three-way branch (auto-convert
// vs section-prepend vs verbatim passthrough) is unit-testable without Slack.
// tv.ai#228 follow-up #4. `hasModals` is passed in rather than derived here
// because it depends on runtime API_URL/TOKEN presence. Returns the raw
// `tableWarning` (the caller decides suppression: convert branch handled the
// table, opt-out/passthrough keeps the #224 warning). No behavior change vs the
// prior inline logic — this is an extraction to lock the branches regressibly.
function buildSendPayload(args, { hasModals = false } = {}) {
  // #225 fix runs first and unconditionally on `text` (not gated behind the
  // agentSuppliedBlocks opt-out like the table converter): even when the agent
  // supplies its own blocks, `text` is still sent — either prepended as a
  // section or as the notification fallback — so the same rendering bug would
  // reach Slack either way. HTML-entity normalization (#243) runs before it —
  // order doesn't matter functionally (disjoint patterns) but boldUrlFixed /
  // boldUrlWrapped below are measured against the entity-normalized text, not
  // raw, so they only flag actual bold-url repairs. #322's wrap runs after
  // #225's strip (see wrapBoldEmbeddedUrl comment for why order matters).
  const rawText = args.text
  const htmlNormalized = typeof rawText === 'string' ? normalizeHtmlEntities(rawText) : rawText
  const stripped = typeof htmlNormalized === 'string' ? stripBoldWrappedUrl(htmlNormalized) : htmlNormalized
  const text = typeof stripped === 'string' ? wrapBoldEmbeddedUrl(stripped) : stripped
  const boldUrlFixed = stripped !== htmlNormalized
  const boldUrlWrapped = text !== stripped

  const agentBlocks = args.blocks ? [...args.blocks] : []
  const agentSuppliedBlocks = agentBlocks.length > 0
  const tableWarning = computePipeTableWarning(text)

  let blocks = agentBlocks
  let effectiveText = text
  let transformed = null

  const converted =
    text?.trim() && tableWarning && !agentSuppliedBlocks
      ? convertPipeTablesToBlocks(text)
      : null
  if (converted) {
    blocks = converted.blocks
    effectiveText = converted.fallbackText
    transformed = converted.transformed
  } else if (text?.trim() && (agentSuppliedBlocks || hasModals)) {
    blocks = [...textToSections(text), ...agentBlocks]
  }

  if (boldUrlFixed) {
    transformed = transformed
      ? { ...transformed, bold_url_stripped: true }
      : { reason: 'bold_wrapped_url_in_text', bold_url_stripped: true }
  }
  if (boldUrlWrapped) {
    transformed = transformed
      ? { ...transformed, bold_url_wrapped: true }
      : { reason: 'bold_wrapped_url_in_text', bold_url_wrapped: true }
  }

  return { blocks, effectiveText, transformed, tableWarning, agentSuppliedBlocks }
}

// Resolve a Slack user_id to a friendly display name. Caches per-process for
// the session lifetime since display names rarely change mid-conversation.
const _userInfoCache = new Map()
async function resolveDisplayName(userId) {
  if (!userId) return userId
  if (_userInfoCache.has(userId)) return _userInfoCache.get(userId)
  try {
    const info = await slackApi('users.info', { user: userId })
    const u = info.user || {}
    const name =
      u.profile?.display_name?.trim() ||
      u.real_name?.trim() ||
      u.name?.trim() ||
      userId
    _userInfoCache.set(userId, name)
    return name
  } catch (err) {
    // users.info is currently degrading silently in production (returns raw userId).
    // Root cause not yet diagnosed — could be the same JSON-body issue as pb#345, or a
    // missing users:read scope. Logged so the next occurrence is diagnosable instead of
    // silently swallowed; do not guess-fix the encoding here (poller-brain#345 review).
    console.error(`resolveDisplayName(${userId}) failed: ${err.message}`)
    _userInfoCache.set(userId, userId)
    return userId
  }
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'send_message',
    description: 'Send a message to the Slack thread. Supports full Slack markdown and Block Kit blocks (for buttons, sections, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text (supports Slack markdown: *bold*, _italic_, `code`, ```code blocks```, > quotes). AUTO-CONVERT: if this contains a GFM pipe-table and you provide NO `blocks`, the table is automatically moved into a `markdown` block (which renders columns) and this field becomes a plain-text notification fallback — the response echoes what changed under `transformed`. To opt out and control layout yourself, supply your own `blocks`. When you DO provide `blocks`, this text is prepended as a visible section block AND used as the notification/accessibility fallback. AUTO-REPAIR: a bare URL wrapped in bold as its own span (`*https://...*`) is auto-stripped to a plain URL — Slack mangles that pattern\'s link (see `transformed.bold_url_stripped`). A bare URL wrapped in bold ALONGSIDE other text (`*see https://...*`) is auto-wrapped as `*see <https://...>*` instead, since stripping would also lose the intended bold (see `transformed.bold_url_wrapped`). Prefer a bare URL or `<url|label>` yourself rather than relying on either repair.' },
        blocks: { type: 'array', description: 'Optional Block Kit blocks array (e.g. sections, actions, or a `markdown` block for tables/GFM). See https://api.slack.com/block-kit. Providing blocks OPTS OUT of table auto-convert — your blocks are sent as-is and `text` is prepended as a visible section block. Omit blocks to let a GFM table in `text` auto-convert.', items: { type: 'object' } },
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
    name: 'get_permalink',
    description: 'Get a clickable Slack permalink URL for a specific message. Use this instead of guessing the workspace subdomain or hand-building an archives/deep-link URL.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        message_ts: { type: 'string', description: 'Timestamp of the message to link to (default: current thread timestamp, or original message timestamp if not in a thread)' },
      },
    },
  },
  {
    name: 'list_thread_participants',
    description: 'List participants in the current thread: user IDs, display names, bot/human flags, and self marker. Use to know "who is in the room" before deciding tags, handoffs, or escalations. Returns deduplicated participants in first-spoke order.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        thread_ts: { type: 'string', description: 'Thread timestamp (default: current thread)' },
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
    name: 'pin_message',
    description: 'Pin a message to a channel. Slack surfaces too_many_pins if the channel is at its pin limit, or not_pinnable for message types that cannot be pinned — both bubble up as errors.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        timestamp: { type: 'string', description: 'Message timestamp to pin (default: current thread timestamp, or original message timestamp if not in a thread)' },
      },
    },
  },
  {
    name: 'unpin_message',
    description: 'Unpin a message from a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (default: current channel)' },
        timestamp: { type: 'string', description: 'Message timestamp to unpin (default: current thread timestamp, or original message timestamp if not in a thread)' },
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
        text: { type: 'string', description: 'New text for the message. When blocks are also provided, text is auto-prepended as section block(s) so it stays visible AND serves as the notification fallback.' },
        blocks: { type: 'array', description: 'New Block Kit blocks to replace existing ones. The `text` field is auto-prepended as section block(s).', items: { type: 'object' } },
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
  {
    name: 'set_expected_duration',
    description: 'Tell the platform roughly how long the work you are about to do will take, so the user gets proactive progress updates if it runs long (0-5 min: no update needed, 5-10 min: one update, 10-15 min: two updates, 15+ min: three updates). Call this once, early, when you can already tell a task will take a while (e.g. a large multi-file refactor or deep research) — not required for normal quick replies. This does not affect timeouts or safety limits, only how often the user hears from you.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Your best-guess estimate of total time this task will take, in minutes' },
      },
      required: ['minutes'],
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

      const hasModals = args.modals?.length && API_URL && TOKEN

      // tv.ai#228 auto-convert: if `text` carries a pipe-table AND the agent
      // did NOT supply its own blocks, move the table(s) into `markdown` block(s)
      // and use a native (non-prepended) plain-text fallback. Deterministic,
      // opt-out by supplying blocks, echoed to the LLM via `transformed`.
      // Everything else keeps the exact prior behavior (fleet-safety: agents
      // that already send blocks+text are untouched). Branch logic lives in the
      // pure buildSendPayload() (unit-tested, no I/O).
      const { blocks, effectiveText, transformed, tableWarning } = buildSendPayload(args, {
        hasModals: Boolean(hasModals),
      })

      // Send the message first (without modal buttons if top-level)
      // We need the message ts for thread context when there's no thread_ts
      const body = {
        channel,
        text: effectiveText,
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
            text: effectiveText,
            blocks: updatedBlocks,
          })
        }
      }

      // Best-effort warning: did we forget to tag the last non-self speaker?
      // Computed after send so warning never delays delivery; agent can
      // follow up with a tagged message if needed. Pass result.ts so the
      // lookback skips the just-sent message (self) — eliminates the race
      // where self appears as last_speaker. See teamvibeai/teamvibe.ai#108.
      const warning = await computeMissingTagWarning(channel, thread_ts, effectiveText, result.ts)
      // Did we reply into a thread the user isn't in? Reads args.thread_ts (not
      // the resolved thread_ts) because the guardrail must tell an explicit
      // override apart from the omitted default. See teamvibeai/teamvibe.ai#184.
      const overrideWarning = await resolveThreadOverrideWarning(args.thread_ts, DEFAULT_THREAD_TS)
      // One signal per branch (DevGuru): the convert branch echoes `transformed`
      // and suppresses the #224 table warning (the table was handled); the
      // opt-out/passthrough branch keeps the table warning. missing_recipient_tag
      // is an orthogonal concern and applies to both.
      const warnings = [warning, overrideWarning]
      if (!transformed && tableWarning) warnings.push(tableWarning)
      return buildSendResponse({ ts: result.ts, transformed, warnings })
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
        ...(m.blocks?.length && { blocks: m.blocks }),
        ...(m.attachments?.length && { attachments: m.attachments }),
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

    case 'get_permalink': {
      const channel = args.channel || DEFAULT_CHANNEL
      const message_ts = args.message_ts || DEFAULT_THREAD_TS || DEFAULT_MESSAGE_TS
      if (!channel) throw new Error('channel required')
      if (!message_ts) throw new Error('message_ts required')
      const result = await slackApi('chat.getPermalink', { channel, message_ts })
      return { ok: true, permalink: result.permalink }
    }

    case 'list_thread_participants': {
      const channel = args.channel || DEFAULT_CHANNEL
      const ts = args.thread_ts || DEFAULT_THREAD_TS
      if (!channel) throw new Error('channel required')
      if (!ts) throw new Error('thread_ts required')
      const self = await resolveSelfIds()
      const result = await slackApi('conversations.replies', { channel, ts, limit: 200 })
      const msgs = result.messages || []
      const seen = new Set()
      const participants = []
      for (const m of msgs) {
        if (m.subtype && m.subtype !== 'bot_message') continue
        if (!m.user || seen.has(m.user)) continue
        seen.add(m.user)
        participants.push({
          user_id: m.user,
          is_bot: Boolean(m.bot_id),
          is_self:
            (self.user_id && m.user === self.user_id) ||
            (self.bot_id && m.bot_id && m.bot_id === self.bot_id),
        })
      }
      await Promise.all(
        participants.map(async (p) => {
          p.display_name = await resolveDisplayName(p.user_id)
        }),
      )
      return { ok: true, participants }
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
        ...(m.blocks?.length && { blocks: m.blocks }),
        ...(m.attachments?.length && { attachments: m.attachments }),
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

    case 'pin_message': {
      // Default mirrors get_permalink, not add_reaction/remove_reaction: pb#315's use
      // case is pinning the top-level tracking message, so an omitted timestamp inside
      // a thread must resolve to the thread root, not the triggering reply.
      const channel = args.channel || DEFAULT_CHANNEL
      const timestamp = args.timestamp || DEFAULT_THREAD_TS || DEFAULT_MESSAGE_TS
      if (!channel) throw new Error('channel required')
      if (!timestamp) throw new Error('timestamp required')
      try {
        await slackApi('pins.add', { channel, timestamp })
      } catch (e) {
        // already_pinned confirmed via Slack docs only, not a live probe (DevGuru,
        // poller-brain#315) — a real pin is a visible channel event, not repeatable
        // freely in review.
        if (e.message?.includes('already_pinned')) return { ok: true, already_pinned: true }
        throw e
      }
      return { ok: true }
    }

    case 'unpin_message': {
      const channel = args.channel || DEFAULT_CHANNEL
      const timestamp = args.timestamp || DEFAULT_THREAD_TS || DEFAULT_MESSAGE_TS
      if (!channel) throw new Error('channel required')
      if (!timestamp) throw new Error('timestamp required')
      try {
        await slackApi('pins.remove', { channel, timestamp })
      } catch (e) {
        // no_pin live-verified against a real unpinned message (DevGuru, poller-brain#315).
        // Slack's docs also list not_pinned for the file-pin variant — this guard only
        // covers the message-pin error string, not files.
        if (e.message?.includes('no_pin')) return { ok: true, no_pin: true }
        throw e
      }
      return { ok: true }
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
      if (args.blocks?.length) {
        body.blocks = args.text?.trim()
          ? [...textToSections(args.text), ...args.blocks]
          : args.blocks
      }
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

    case 'set_expected_duration': {
      // No Slack API call — this tool exists purely as a signal. The poller
      // reads this tool_use event directly off the Claude Code stdout stream
      // (packages/poller/src/claude-spawner.ts) and drives the tiered
      // progress-notification schedule from it. Nothing to do here but
      // validate and acknowledge.
      const minutes = Number(args.minutes)
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error('minutes must be a positive number')
      }
      return { ok: true, minutes }
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
