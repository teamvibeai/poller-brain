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
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'bg-task-runner.mjs')

const TTL_MIN = 30
const TTL_MAX = 21600

const USAGE =
  'usage: bg-task.mjs [--name NAME] [--ttl SECONDS] [--channel SLACK_CHANNEL] ' +
  '[--thread THREAD_TS] [--dry-run] -- <command...>'

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
    cmd: [],
  }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { i++; break }
    const needsValue = ['--name', '--ttl', '--channel', '--thread'].includes(a)
    if (needsValue && i + 1 >= argv.length) return { error: `${a} needs a value` }
    switch (a) {
      case '--name': opts.name = argv[++i]; break
      case '--ttl': opts.ttl = argv[++i]; break
      case '--channel': opts.channel = argv[++i]; break
      case '--thread': opts.thread = argv[++i]; break
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
  return { opts }
}

export const REQUIRED_ENV = [
  'TEAMVIBE_API_URL',
  'TEAMVIBE_POLLER_TOKEN',
  'TEAMVIBE_WORKSPACE_ID',
  'TEAMVIBE_CHANNEL_ID',
]

export function taskId(name, pid, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${pid}-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

// --- main -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseArgs(process.argv.slice(2), process.env)
  if (parsed.help) { console.log(USAGE); process.exit(0) }
  if (parsed.error) die(parsed.error)
  const { opts } = parsed

  for (const v of REQUIRED_ENV) {
    if (!process.env[v]) die(`missing environment variable ${v} — cannot deliver the finish signal`, 2)
  }

  // Namespaced per channel: a poller can host several brains and they share
  // $PERSISTENT_STORAGE_PATH. Without the namespace, two brains starting a same-named
  // task in the same second collide on one directory. Hygiene, not isolation — every
  // brain on the poller runs as the same user (spelled out in skill.md).
  const root = join(
    process.env.BG_TASK_ROOT || join(process.env.PERSISTENT_STORAGE_PATH || '/tmp', 'bg-tasks'),
    process.env.TEAMVIBE_CHANNEL_ID,
  )
  const id = taskId(opts.name, process.pid, new Date())
  const dir = join(root, id)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    die(`cannot create task directory ${dir}: ${e.message}`, 1)
  }

  // One argument per line — the reviewable record of what was actually launched.
  writeFileSync(join(dir, 'cmd'), opts.cmd.join('\n') + '\n')

  const out = openSync(join(dir, 'runner.stdout'), 'a')
  // detached: true puts the runner in its own session and process group, so the
  // spawner killing the session's process group at teardown cannot reach it. This is
  // the whole trick — verified empirically in pb#231 (survived a full teardown).
  const child = spawn(
    process.execPath,
    [RUNNER, dir, String(opts.ttl), opts.name, opts.channel, opts.thread, opts.dryRun ? '1' : '0', '--', ...opts.cmd],
    { detached: true, stdio: ['ignore', out, out] },
  )
  child.unref()

  console.log(`bg-task launched: name=${opts.name} id=${id} ttl=${opts.ttl}s`)
  console.log(`dir=${dir} (status, output.log, cmd)`)
  console.log('You will be woken in this channel ~1 min after it ends. Do not poll — end your turn.')
}
