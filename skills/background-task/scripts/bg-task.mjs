#!/usr/bin/env node
// bg-task.mjs — launch a long-running command detached from the current agent session
// and get woken up in this channel when it ends.
//
//   node bg-task.mjs --name build --ttl 1800 -- npm run build
//
// Two-process design: this launcher validates and returns immediately; bg-task-runner.mjs
// is spawned detached (its own session, via `detached: true` → setsid) and is what
// actually outlives the session teardown.
//
// Reliability bar: BEST-EFFORT (see skill.md). Survives the launching session. Does NOT
// survive a poller restart. Never present it to a user as a durability guarantee.
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'bg-task-runner.mjs')

const TTL_MIN = 30
const TTL_MAX = 21600
// Wake is scheduled this many seconds after the command ends, overridable via
// BG_TASK_WAKE_DELAY. Not zero on purpose — see buildBody in bg-task-runner.mjs.
const DEFAULT_WAKE_DELAY = 30

const USAGE =
  'usage: bg-task.mjs [--name NAME] [--ttl SECONDS] [--channel SLACK_CHANNEL] ' +
  '[--thread THREAD_TS] [--note TEXT] [--dry-run] -- <command...>\n' +
  '       bg-task.mjs --list'

function die(msg, code = 2) {
  console.error(`bg-task: ${msg}`)
  if (code === 2) console.error(USAGE)
  process.exit(code)
}

// --- argv -------------------------------------------------------------------------
export function parseArgs(argv, env = {}) {
  const opts = {
    name: 'task',
    ttl: 900,
    channel: env.SLACK_CHANNEL || '',
    thread: env.SLACK_THREAD_TS || '',
    dryRun: env.BG_TASK_DRY === '1',
    wakeDelay: env.BG_TASK_WAKE_DELAY ?? String(DEFAULT_WAKE_DELAY),
    note: '',
    cmd: [],
  }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { i++; break }
    if (a === '--list') return { list: true }
    const needsValue = ['--name', '--ttl', '--channel', '--thread', '--note'].includes(a)
    if (needsValue && i + 1 >= argv.length) return { error: `${a} needs a value` }
    switch (a) {
      case '--name': opts.name = argv[++i]; break
      case '--ttl': opts.ttl = argv[++i]; break
      case '--channel': opts.channel = argv[++i]; break
      case '--thread': opts.thread = argv[++i]; break
      case '--note': opts.note = argv[++i]; break
      case '--dry-run': opts.dryRun = true; break
      case '-h': case '--help': return { help: true }
      default: return { error: `unknown argument: ${a}` }
    }
  }
  opts.cmd = argv.slice(i)

  if (!opts.cmd.length) return { error: 'no command given (everything after -- is the command)' }
  if (!/^\d+$/.test(String(opts.ttl))) return { error: '--ttl must be an integer number of seconds' }
  opts.ttl = Number(opts.ttl)
  // Floor keeps the wake path meaningful (the scheduler ticks about once a minute);
  // ceiling is 6 h so a forgotten task cannot hold a slot indefinitely.
  if (opts.ttl < TTL_MIN || opts.ttl > TTL_MAX) {
    return { error: `--ttl must be between ${TTL_MIN} and ${TTL_MAX} seconds` }
  }
  if (!opts.channel) {
    return { error: 'no target channel — pass --channel or run where SLACK_CHANNEL is set' }
  }
  if (!/^\d+$/.test(String(opts.wakeDelay))) {
    return { error: 'BG_TASK_WAKE_DELAY must be an integer number of seconds' }
  }
  opts.wakeDelay = Number(opts.wakeDelay)
  return { opts }
}

export const REQUIRED_ENV = [
  'TEAMVIBE_API_URL',
  'TEAMVIBE_POLLER_TOKEN',
  'TEAMVIBE_WORKSPACE_ID',
  'TEAMVIBE_CHANNEL_ID',
]

// Namespaced per channel: a poller can host several brains and they share
// $PERSISTENT_STORAGE_PATH. Without the namespace, two brains starting a same-named task
// in the same second collide on one directory. Hygiene, not isolation — every brain on
// the poller runs as the same user (spelled out in skill.md).
export function taskRoot(env) {
  return join(
    env.BG_TASK_ROOT || join(env.PERSISTENT_STORAGE_PATH || '/tmp', 'bg-tasks'),
    env.TEAMVIBE_CHANNEL_ID,
  )
}

export function taskId(name, pid, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${pid}-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

// --- listing ----------------------------------------------------------------------
// A task whose wake notification never arrived is invisible otherwise: the state is on
// disk, but you have to know to go looking. --list makes that recoverable, and also
// answers "what else is running right now", which is otherwise only visible via ps.

export function parseStatus(text) {
  const kv = {}
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1)
  }
  return kv
}

// Wake delivery is its own column because "the task finished" and "you were told" are
// different facts, and only the second one can silently fail.
//
// Every value here asserts exactly what the status file proves and no more. `enqueued`
// deliberately does NOT claim "delivered" — the status file cannot know that; it only
// knows the API accepted the schedule. Naming it `sent` invited the same conflation the
// `new/` -> `processing/` transition invites (a move proves pickup, not processing).
// When the inbox-drop + cancel-on-pickup path lands it must add its OWN values
// (`cancelled`, `delivered-inbox`), not reuse this one: a schedule the runner cancelled
// because the other path delivered first is a different fact again.
function wakeStateOf(kv, state) {
  if (kv.dry_run) return 'dry-run'
  if (kv.enqueue_failed) return 'FAILED'
  if (kv.runner_crashed) return 'FAILED'
  if (kv.enqueued) {
    const code = kv.http_status
    return code && !['200', '201'].includes(code) ? `http ${code}` : 'enqueued'
  }
  return state === 'running' ? '-' : 'pending'
}

export function taskRow(id, statusText) {
  const kv = parseStatus(statusText)
  const m = /^(\d{8}T\d{6}Z)-(\d+)-(.*)$/.exec(id)
  const state = kv.state || 'running'
  let elapsed = ''
  if (kv.started && kv.ended) {
    const secs = Math.round((Date.parse(kv.ended) - Date.parse(kv.started)) / 1000)
    if (Number.isFinite(secs)) elapsed = `${secs}s`
  }
  return {
    id,
    name: m ? m[3] : id,
    state,
    rc: kv.rc ?? '',
    ended: kv.ended || '',
    elapsed,
    wake: wakeStateOf(kv, state),
  }
}

export function listTasks(root) {
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries
    .map((id) => {
      let status = ''
      try {
        status = readFileSync(join(root, id, 'status'), 'utf8')
      } catch { /* dir without status yet — still worth listing as running */ }
      return taskRow(id, status)
    })
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

export function formatTaskList(rows) {
  if (!rows.length) return 'no background tasks recorded for this channel'
  const head = { name: 'NAME', state: 'STATE', rc: 'RC', elapsed: 'RAN', ended: 'ENDED', wake: 'WAKE' }
  const cols = ['name', 'state', 'rc', 'elapsed', 'ended', 'wake']
  const width = {}
  for (const c of cols) {
    width[c] = Math.max(head[c].length, ...rows.map((r) => String(r[c]).length))
  }
  const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join('  ').trimEnd()
  const running = rows.filter((r) => r.state === 'running').length
  return [
    line(head),
    ...rows.map(line),
    '',
    `${rows.length} task${rows.length === 1 ? '' : 's'}, ${running} still running`,
  ].join('\n')
}

// --- main -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseArgs(process.argv.slice(2), process.env)
  if (parsed.help) { console.log(USAGE); process.exit(0) }

  // --list is read-only: it needs the channel namespace and nothing else, so it must not
  // be gated behind the launch-path validation (a command, an API token).
  if (parsed.list) {
    if (!process.env.TEAMVIBE_CHANNEL_ID) die('missing environment variable TEAMVIBE_CHANNEL_ID', 2)
    console.log(formatTaskList(listTasks(taskRoot(process.env))))
    process.exit(0)
  }

  if (parsed.error) die(parsed.error)
  const { opts } = parsed

  for (const v of REQUIRED_ENV) {
    if (!process.env[v]) die(`missing environment variable ${v} — cannot deliver the finish signal`, 2)
  }

  const root = taskRoot(process.env)
  const id = taskId(opts.name, process.pid, new Date())
  const dir = join(root, id)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    die(`cannot create task directory ${dir}: ${e.message}`, 1)
  }

  // One argument per line — the reviewable record of what was actually launched.
  writeFileSync(join(dir, 'cmd'), opts.cmd.join('\n') + '\n')

  // The wake payload can only ever report WHAT happened (state, rc, output). WHY the task
  // was launched, and what to do with the answer, is known only here — by the session that
  // is still alive. Without it the woken session can report the result but cannot continue
  // the work (canary finding, pb#231). Written as a file rather than threaded through
  // argv: it is free text, and the runner reads the task dir anyway.
  if (opts.note) writeFileSync(join(dir, 'note'), opts.note.endsWith('\n') ? opts.note : opts.note + '\n')

  const out = openSync(join(dir, 'runner.stdout'), 'a')
  // detached: true puts the runner in its own session and process group, so the
  // spawner killing the session's process group at teardown cannot reach it. This is
  // the whole trick — verified empirically in pb#231 (survived a full teardown).
  const child = spawn(
    process.execPath,
    [RUNNER, dir, String(opts.ttl), opts.name, opts.channel, opts.thread, opts.dryRun ? '1' : '0',
      String(opts.wakeDelay), '--', ...opts.cmd],
    { detached: true, stdio: ['ignore', out, out] },
  )
  child.unref()

  console.log(`bg-task launched: name=${opts.name} id=${id} ttl=${opts.ttl}s`)
  console.log(`dir=${dir} (status, output.log, cmd)`)
  console.log('You will be woken in this channel ~1 min after it ends. Do not poll — end your turn.')
}
