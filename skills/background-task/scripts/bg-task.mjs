#!/usr/bin/env node
// bg-task.mjs — launch a long-running command detached from the current agent session
// and get woken up in this thread when it ends (plus interim checkpoints while it runs).
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

const USAGE =
  'usage: bg-task.mjs [--name NAME] [--ttl SECONDS] [--note TEXT] [--notify-on REGEX] ' +
  '[--quiet-checkpoints | --checkpoint-interval SECONDS] [--dry-run] [--no-wake] -- <command...>\n' +
  '       bg-task.mjs --list'

function die(msg, code = 2) {
  console.error(`bg-task: ${msg}`)
  if (code === 2) console.error(USAGE)
  process.exit(code)
}

// Mirrors parseSlackThreadId in teamvibe.ai's packages/poller/src/inbox-watcher.ts — the
// only threadId shape the inbox watcher will ever pick back up. Can't import it across
// repos, so keep this in sync by hand if that function's rule changes (differential-fuzzed
// against the platform original, DevGuru, 2026-08-25 — 200k+ inputs, 0 mismatches).
// 3 colon-separated segments, 2nd and 3rd non-empty, 1st (botId) != 'scheduled' — the
// FIRST segment is allowed to be empty (`:C0:1.2` is valid), only the other two are not.
// Catching a non-Slack-shaped INBOX_THREAD_ID here (Scheduler(system)- or maintenance-
// origin sessions, e.g. `scheduled:<id>:<ts>` or `maintenance_<brainId>_<ts>`) turns a
// permanent, silent drop-into-the-void (poller-brain#384/#385) into a loud failure the
// launching session can still act on.
export function isSlackShapedThreadId(threadId) {
  const parts = threadId.split(':')
  if (parts.length !== 3) return false
  const [botId, channel, threadTs] = parts
  if (botId === 'scheduled') return false
  if (!channel || !threadTs) return false
  return true
}

// --- argv -------------------------------------------------------------------------
export function parseArgs(argv, env = {}) {
  const opts = {
    name: 'task',
    ttl: 900,
    // The full `<botId>:<channel>:<threadTs>` the poller stamps as INBOX_THREAD_ID for
    // every session (claude-spawner.ts) — the one value the inbox watcher's
    // parseSlackThreadId accepts. There is no override flag: unlike the old scheduled-
    // message path, a drop always lands in the thread that launched it. That closes the
    // lateral-channel-override gap the old --channel flag had (teamvibe.ai#244).
    threadId: env.INBOX_THREAD_ID || '',
    dryRun: env.BG_TASK_DRY === '1',
    notifyOn: '',
    note: '',
    // Suppresses the quiet-period and ceiling checkpoint triggers (see bg-task-runner.mjs)
    // — opt-in, because losing interim visibility is a real cost, right for a known
    // high-frequency-output task where only completion (or a --notify-on match) matters.
    // See poller-brain#403.
    quietCheckpoints: false,
    // Replaces BOTH the quiet-debounce and the ttl-derived ceiling with a single "flush no
    // more often than every N seconds" trigger — for a task with predictable short gaps
    // between lines (the debounce always wins there, long before the ceiling could), where
    // periodic status beats either the 1.5s-eager default or --quiet-checkpoints' total
    // silence. 0 means "not set". See poller-brain#403 (round 2, Jakub).
    checkpointInterval: 0,
    // Separate from checkpointInterval's own truthiness on purpose (poller-brain#403 round
    // 3, DevGuru): `--checkpoint-interval ""` (an unset shell var expanding to nothing,
    // e.g. `--checkpoint-interval "$INTERVAL"`) consumes the flag with an empty string,
    // which is falsy — checking `opts.checkpointInterval` alone would silently skip BOTH
    // the validation below and the mutual-exclusion check, and fall through to the runner
    // as "not set", reverting to the eager default with zero indication anything was wrong.
    checkpointIntervalGiven: false,
    // Bypasses the Slack-shaped-threadId check below — for a session that knows it can't
    // be woken (Scheduler/maintenance-origin) but wants the task to run anyway, reading
    // the result back later via --list/the task dir instead of a delivered drop.
    noWake: false,
    cmd: [],
  }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { i++; break }
    if (a === '--list') return { list: true }
    const needsValue = ['--name', '--ttl', '--note', '--notify-on', '--checkpoint-interval'].includes(a)
    if (needsValue && i + 1 >= argv.length) return { error: `${a} needs a value` }
    switch (a) {
      case '--name': opts.name = argv[++i]; break
      case '--ttl': opts.ttl = argv[++i]; break
      case '--note': opts.note = argv[++i]; break
      case '--notify-on': opts.notifyOn = argv[++i]; break
      case '--quiet-checkpoints': opts.quietCheckpoints = true; break
      case '--checkpoint-interval': opts.checkpointInterval = argv[++i]; opts.checkpointIntervalGiven = true; break
      case '--dry-run': opts.dryRun = true; break
      case '--no-wake': opts.noWake = true; break
      case '-h': case '--help': return { help: true }
      default: return { error: `unknown argument: ${a}` }
    }
  }
  opts.cmd = argv.slice(i)

  if (!opts.cmd.length) return { error: 'no command given (everything after -- is the command)' }
  if (!/^\d+$/.test(String(opts.ttl))) return { error: '--ttl must be an integer number of seconds' }
  opts.ttl = Number(opts.ttl)
  // Floor keeps a checkpoint interval meaningful (flushIntervalSec would otherwise clamp
  // to a floor bigger than the task itself); ceiling is 6 h so a forgotten task cannot
  // hold a slot indefinitely.
  if (opts.ttl < TTL_MIN || opts.ttl > TTL_MAX) {
    return { error: `--ttl must be between ${TTL_MIN} and ${TTL_MAX} seconds` }
  }
  if (!opts.threadId) {
    return { error: 'no thread to report back to — INBOX_THREAD_ID is not set in this session\'s environment' }
  }
  if (!isSlackShapedThreadId(opts.threadId) && !opts.noWake) {
    return {
      error: `INBOX_THREAD_ID (${opts.threadId}) is not a Slack-shaped thread — the inbox ` +
        'watcher will never pick up a drop here (poller-brain#384/#385), so this task cannot ' +
        'wake a new session once this one ends its turn. Pass --no-wake to launch it anyway ' +
        'and read the result back yourself later via --list or the task dir.',
    }
  }
  if (opts.notifyOn) {
    try { new RegExp(opts.notifyOn) } catch (e) {
      return { error: `--notify-on is not a valid regex: ${e.message}` }
    }
  }
  // Ambiguous combination, not silently resolved: "suppress everything" and "flush every N
  // seconds" answer different questions about the same triggers, and picking one for the
  // caller risks masking a copy-paste mistake in an unattended background task. Checked
  // BEFORE the value validation below (against checkpointIntervalGiven, not the value's
  // truthiness) so this fires even when the value itself is also invalid — the conflict is
  // in specifying both flags at all, not in what --checkpoint-interval was set to.
  if (opts.quietCheckpoints && opts.checkpointIntervalGiven) {
    return { error: '--quiet-checkpoints and --checkpoint-interval are mutually exclusive — pick one' }
  }
  // Checked against checkpointIntervalGiven, not opts.checkpointInterval's truthiness — see
  // the field's own comment above: an explicitly-passed empty value must still hit this
  // validation, not silently read as "not set" and fall through to the eager default.
  if (opts.checkpointIntervalGiven) {
    // Same integer-string check as --ttl above, for consistency. 0 and negative are
    // rejected outright (a "flush every 0 seconds" interval is not a periodic trigger,
    // it's the eager behavior this flag exists to replace).
    if (!/^\d+$/.test(String(opts.checkpointInterval)) || Number(opts.checkpointInterval) <= 0) {
      return { error: '--checkpoint-interval must be a positive integer number of seconds' }
    }
    opts.checkpointInterval = Number(opts.checkpointInterval)
    // >= , not > : at N == ttl the flush would race the TTL kill and could produce at most
    // one checkpoint duplicating the terminal drop — not a periodic trigger at all, just a
    // confusing way to spell "never". --quiet-checkpoints says that honestly.
    if (opts.checkpointInterval >= opts.ttl) {
      return {
        error: `--checkpoint-interval (${opts.checkpointInterval}s) must be less than --ttl (${opts.ttl}s)` +
          ' — it would never meaningfully fire before the terminal drop; use --quiet-checkpoints if you want no interim checkpoints at all',
      }
    }
  }
  return { opts }
}

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
// A task whose terminal drop never arrived is invisible otherwise: the state is on
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

// Grace on top of the TTL before a runner that has written no terminal line is called
// abandoned: the TTL kill has a 5 s SIGKILL grace, and clocks/scheduling add a little.
const ABANDON_GRACE_SEC = 60

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

// What actually happened to this task, which is NOT the same question as "did it write a
// state line". A runner killed with the container — the documented failure mode of this
// whole feature, a poller restart takes in-flight tasks with it — writes neither `state=`
// nor `runner_crashed=`. Reading that silence as "running" makes every such dir running
// FOREVER: --list keeps showing it, the sibling counter keeps promising wakes that will
// never come, and it only ever grows, because nothing expires.
//
// So absence of a terminal line asks two further questions: is the runner still there
// (pid), and could it still plausibly be working (age vs its own TTL)? The age check also
// covers pid reuse after a restart, where some unrelated process now owns that number.
export function lifecycleOf(kv, { now = Date.now(), alive = pidAlive } = {}) {
  if (kv.state) return kv.state // finished | timed-out — the runner said so itself
  if (kv.runner_crashed) return 'crashed'
  // Nothing written at all: either the runner is a few milliseconds from its first line,
  // or the dir was orphaned before it ever wrote one. Both are consistent with this file,
  // so say so rather than guess — `running` and `abandoned` are each a claim too far.
  if (Object.keys(kv).length === 0) return 'unknown'
  const pid = Number(kv.pid)
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return 'abandoned'
  const started = Date.parse(kv.started)
  const ttl = Number(String(kv.ttl ?? '').replace(/s$/, ''))
  if (Number.isFinite(started) && Number.isFinite(ttl)
    && now - started > (ttl + ABANDON_GRACE_SEC) * 1000) return 'abandoned'
  return 'running'
}

// Delivery is its own column because "the task finished" and "you were told" are
// different facts, and only the second one can silently fail.
//
//   dropped   the terminal write into .inbox/ succeeded — either a running session will
//             pick it up on its own next check, or the inbox watcher will start one.
//   FAILED    the write itself threw (permissions, disk full, missing .inbox/ parent) —
//             we have an answer and it is bad.
//   pending   the command ended and the drop is plausibly still being written — the write
//             is synchronous, so this window is just process-scheduling slack, not a
//             network round trip the way the old HTTP path's `UNKNOWN` was.
//   NONE      nobody is left to drop it. Two routes reach it: the runner vanished
//             mid-command (`state=abandoned`), or it recorded the end and then died
//             before writing a verdict — a poller restart, the documented non-durability
//             edge. Both are "never", not "not yet".
//   dry-run   --dry-run: nothing was written to the real inbox.
//   no-wake   --no-wake: diverted to the task dir on purpose (poller-brain#384) — read it
//             back with --list, not a delivery failure even though terminal_drop isn't 'ok'.
//
// A synchronous fs write collapses the old FAILED/UNKNOWN split from the HTTP-based
// design (teamvibe.ai#250 removed the network hop entirely): there is no transport that
// can die without an answer, only a write that throws or doesn't.
const DROP_IN_FLIGHT_MS = 5000

function wakeStateOf(kv, state, now) {
  if (kv.dry_run) return 'dry-run'
  if (kv.no_wake) return 'no-wake'
  if (kv.runner_crashed) return 'FAILED'
  const verdict = kv.terminal_drop
  if (verdict) return verdict === 'ok' ? 'dropped' : 'FAILED'
  if (state === 'running') return '-'
  if (state === 'abandoned') return 'NONE'
  const ended = Date.parse(kv.ended || '')
  if (Number.isFinite(ended) && now - ended > DROP_IN_FLIGHT_MS) return 'NONE'
  return 'pending'
}

export function taskRow(id, statusText, opts = {}) {
  const kv = parseStatus(statusText)
  const m = /^(\d{8}T\d{6}Z)-(\d+)-(.*)$/.exec(id)
  // One clock for both questions: the lifecycle and the wake state of a single row must
  // never be read a few milliseconds apart and disagree about how old it is.
  const now = opts.now ?? Date.now()
  const state = lifecycleOf(kv, { ...opts, now })
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
    wake: wakeStateOf(kv, state, now),
  }
}

export function listTasks(root, opts = {}) {
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  // One clock for the whole listing, read once: rows are aged against it, and two tasks
  // that ended at the same moment must not land on different sides of the threshold
  // because the walk took a second.
  const at = { ...opts, now: opts.now ?? Date.now() }
  return entries
    .map((id) => {
      let status = ''
      try {
        status = readFileSync(join(root, id, 'status'), 'utf8')
      } catch { /* dir without status yet — still worth listing as running */ }
      return taskRow(id, status, at)
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
  // be gated behind the launch-path validation (a command, a thread to report back to).
  if (parsed.list) {
    if (!process.env.TEAMVIBE_CHANNEL_ID) die('missing environment variable TEAMVIBE_CHANNEL_ID', 2)
    console.log(formatTaskList(listTasks(taskRoot(process.env))))
    process.exit(0)
  }

  if (parsed.error) die(parsed.error)
  const { opts } = parsed

  if (!process.env.TEAMVIBE_CHANNEL_ID) {
    die('missing environment variable TEAMVIBE_CHANNEL_ID — cannot namespace task storage', 2)
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
    [RUNNER, dir, String(opts.ttl), opts.name, opts.threadId, opts.dryRun ? '1' : '0',
      opts.notifyOn, opts.quietCheckpoints ? '1' : '0', opts.checkpointInterval ? String(opts.checkpointInterval) : '',
      opts.noWake ? '1' : '0',
      '--', ...opts.cmd],
    { detached: true, stdio: ['ignore', out, out] },
  )
  child.unref()

  console.log(`bg-task launched: name=${opts.name} id=${id} ttl=${opts.ttl}s`)
  console.log(`dir=${dir} (status, output.log, cmd)`)
  // Must mirror the runner's own divert decision (writeInboxMessage: noWake === '1' diverts
  // unconditionally, independent of thread shape) — checking isSlackShapedThreadId() alone
  // here claimed delivery would happen even when --no-wake forces a divert on a perfectly
  // valid thread, printing a promise the runner had no intention of keeping (poller-brain#384
  // round 4, DevGuru).
  const willDeliver = isSlackShapedThreadId(opts.threadId) && !opts.noWake
  if (willDeliver) {
    console.log('You will get interim checkpoints and a final result in this thread. Do not poll — end your turn.')
  } else {
    console.log(
      `No delivery in this session type (--no-wake) — nothing will land in this thread. ` +
        `Read the result back later with: node bg-task.mjs --list (look for name=${opts.name}).`,
    )
  }
}
