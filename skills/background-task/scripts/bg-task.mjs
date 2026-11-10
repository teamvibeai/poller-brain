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
// Reliability bar: BEST-EFFORT (see SKILL.md). Survives the launching session. Does NOT
// survive a poller restart. Never present it to a user as a durability guarantee.
import { ChildProcess, spawn } from 'node:child_process'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'bg-task-runner.mjs')

const TTL_MIN = 30
const TTL_MAX = 21600

const USAGE =
  'usage: bg-task.mjs [--name NAME] [--ttl SECONDS] [--note TEXT] [--notify-on REGEX] ' +
  '[--quiet-checkpoints | --checkpoint-interval SECONDS | --eager-checkpoints] [--stdin-file PATH] [--dry-run] -- <command...>\n' +
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
    // The full `<botId>:<channel>:<threadTs>` the poller stamps as INBOX_THREAD_ID for
    // every session (claude-spawner.ts) — the one value the inbox watcher's
    // parseSlackThreadId accepts. There is no override flag: unlike the old scheduled-
    // message path, a drop always lands in the thread that launched it. That closes the
    // lateral-channel-override gap the old --channel flag had (teamvibe.ai#244).
    threadId: env.INBOX_THREAD_ID || '',
    dryRun: env.BG_TASK_DRY === '1',
    notifyOn: '',
    note: '',
    stdinFile: '',
    // Suppresses the quiet-period and ceiling checkpoint triggers (see bg-task-runner.mjs)
    // — opt-in, because losing interim visibility is a real cost, right for a known
    // high-frequency-output task where only completion (or a --notify-on match) matters.
    // See poller-brain#403.
    quietCheckpoints: false,
    // Replaces BOTH the quiet-debounce and the ttl-derived ceiling with a single "flush no
    // more often than every N seconds" trigger — for a task with predictable short gaps
    // between lines (the debounce always wins there, long before the ceiling could), where
    // periodic status beats either the eager default or --quiet-checkpoints' total
    // silence. 0 means "not set". See poller-brain#403 (round 2, Jakub).
    checkpointInterval: 0,
    // Restores the pre-#489 default (quiet-period debounce + ttl-derived ceiling, both
    // eager) — opt-in, because losing that fast interim visibility is a real cost, right
    // for a task whose caller actually reads along as it runs. The DEFAULT as of #489 is
    // instead a plain ttl-derived periodic cadence (see bg-task-runner.mjs's
    // flushIntervalSec): a wrapper script that just polls-and-echoes every ~20s for a
    // 30-minute wait was spamming a checkpoint on nearly every burst under the old eager
    // default, for tasks where only the terminal result actually mattered (Jakub,
    // poller-brain#489).
    eagerCheckpoints: false,
    // Separate from checkpointInterval's own truthiness on purpose (poller-brain#403 round
    // 3, DevGuru): `--checkpoint-interval ""` (an unset shell var expanding to nothing,
    // e.g. `--checkpoint-interval "$INTERVAL"`) consumes the flag with an empty string,
    // which is falsy — checking `opts.checkpointInterval` alone would silently skip BOTH
    // the validation below and the mutual-exclusion check, and fall through to the runner
    // as "not set", reverting to the eager default with zero indication anything was wrong.
    checkpointIntervalGiven: false,
    cmd: [],
  }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { i++; break }
    if (a === '--list') return { list: true }
    const needsValue = ['--name', '--ttl', '--note', '--notify-on', '--checkpoint-interval', '--stdin-file'].includes(a)
    if (needsValue && i + 1 >= argv.length) return { error: `${a} needs a value` }
    switch (a) {
      case '--name': opts.name = argv[++i]; break
      case '--ttl': opts.ttl = argv[++i]; break
      case '--note': opts.note = argv[++i]; break
      case '--stdin-file':
        if (!argv[i + 1]) return { error: '--stdin-file needs a nonempty path' }
        opts.stdinFile = resolve(argv[++i]); break
      case '--notify-on': opts.notifyOn = argv[++i]; break
      case '--quiet-checkpoints': opts.quietCheckpoints = true; break
      case '--checkpoint-interval': opts.checkpointInterval = argv[++i]; opts.checkpointIntervalGiven = true; break
      case '--eager-checkpoints': opts.eagerCheckpoints = true; break
      case '--dry-run': opts.dryRun = true; break
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
  if (opts.notifyOn) {
    try { new RegExp(opts.notifyOn) } catch (e) {
      return { error: `--notify-on is not a valid regex: ${e.message}` }
    }
  }
  // Ambiguous combination, not silently resolved: "suppress everything", "flush every N
  // seconds", and "restore the eager debounce+ceiling" each answer a different question
  // about the same triggers, and picking one for the caller risks masking a copy-paste
  // mistake in an unattended background task. Checked BEFORE the value validation below
  // (against checkpointIntervalGiven, not the value's truthiness) so this fires even when
  // the value itself is also invalid — the conflict is in specifying more than one of
  // these flags at all, not in what --checkpoint-interval was set to.
  const triggerModeFlags = [
    opts.quietCheckpoints && '--quiet-checkpoints',
    opts.checkpointIntervalGiven && '--checkpoint-interval',
    opts.eagerCheckpoints && '--eager-checkpoints',
  ].filter(Boolean)
  if (triggerModeFlags.length > 1) {
    return { error: `${triggerModeFlags.join(' and ')} are mutually exclusive — pick one` }
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

// Match the poller wrappers' admission rule. Report only the env name, never its value.
export function secretArgEnvName(argv, env = process.env) {
  return Object.entries(env).find(([name, value]) =>
    /TOKEN|SECRET|_KEY|PASSWORD/i.test(name) && value?.length >= 12 &&
    argv.some(arg => arg.includes(value)))?.[0]
}

// Namespaced per channel: a poller can host several brains and they share
// $PERSISTENT_STORAGE_PATH. Without the namespace, two brains starting a same-named task
// in the same second collide on one directory. Hygiene, not isolation — every brain on
// the poller runs as the same user (spelled out in SKILL.md).
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
//
// A synchronous fs write collapses the old FAILED/UNKNOWN split from the HTTP-based
// design (teamvibe.ai#250 removed the network hop entirely): there is no transport that
// can die without an answer, only a write that throws or doesn't.
const DROP_IN_FLIGHT_MS = 5000

function wakeStateOf(kv, state, now) {
  if (kv.dry_run) return 'dry-run'
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
  // Check the original environment before an adapter can strip any credentials.
  const secretName = secretArgEnvName(opts.cmd, process.env)
  if (secretName) {
    die(`refusing command argv containing secret environment variable ${secretName}; use env or --stdin-file`)
  }

  if (!process.env.TEAMVIBE_CHANNEL_ID) {
    die('missing environment variable TEAMVIBE_CHANNEL_ID — cannot namespace task storage', 2)
  }

  const root = taskRoot(process.env)
  const id = taskId(opts.name, process.pid, new Date())
  const dir = join(root, id)
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    mkdirSync(dir, { mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('task path must be a real directory')
  } catch (e) {
    die(`cannot create task directory ${dir}: ${e.message}`, 1)
  }

  // The runner inherits env values; only their names belong in the private handoff.
  // Prompts, workload argv and notes must never become the detached runner's argv.
  const specPath = join(dir, 'spec.json')
  let out, child
  let ownsSpec = true
  let launchFailed = false
  try {
    writeFileSync(specPath, JSON.stringify({ ...opts, dir, cwd: process.cwd(), envNames: Object.keys(process.env) }),
      { mode: 0o600, flag: 'wx' })

    out = openSync(join(dir, 'runner.stdout'), 'a')
    // detached: true puts the runner in its own session and process group, so the
    // spawner killing the session's process group at teardown cannot reach it. This is
    // the whole trick — verified empirically in pb#231 (survived a full teardown).
    // Pollers with on-demand Git credentials (teamvibe.ai#633) export a launcher that
    // registers the task so the session's credential files outlive the session, and strips
    // the poller token from the runner env. Older pollers don't set it; a broken adapter
    // must never stop a background task from starting, so fall back to plain spawn.
    const runnerArgs = [RUNNER, specPath]
    const runnerOptions = { detached: true, stdio: ['ignore', out, out] }
    if (process.env.TV_GIT_BG_TASK_LAUNCHER) {
      // Apply the adapter's token policy before either path starts the interpreter.
      // With no launcher configured, preserve the older poller's inherited environment.
      runnerOptions.env = { ...process.env }
      delete runnerOptions.env.TEAMVIBE_POLLER_TOKEN
      try {
        const adapter = await import(process.env.TV_GIT_BG_TASK_LAUNCHER)
        const originalSpawn = ChildProcess.prototype.spawn
        let started
        // Older adapters register args[1] as a directory to retain Git credentials.
        // Keep that interface, then substitute the private spec path at the actual spawn.
        // Adopt this runner (interpreter flags allowed) regardless
        // of the hook's return value or a later exception; other helpers don't count.
        try {
          ChildProcess.prototype.spawn = function (options) {
            if (options?.args?.includes(RUNNER) && options.args.includes(dir)) {
              options = { ...options, args: options.args.map(arg => arg === dir ? specPath : arg) }
            }
            const result = originalSpawn.call(this, options)
            if (options?.args?.includes(RUNNER) && options.args.includes(specPath)) started ??= this
            return result
          }
          adapter.spawnBackgroundTask(process.execPath, [RUNNER, dir], runnerOptions)
        } finally {
          ChildProcess.prototype.spawn = originalSpawn
          child = started
        }
      } catch {
        // Exception messages can contain credentials, paths or embedded newlines.
        process.stderr.write('bg-task: git credential launcher unavailable; continuing background task\n')
      }
    }
    child ??= spawn(process.execPath, runnerArgs, runnerOptions)
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    // The runner owns spec cleanup only once the OS has successfully started it.
    ownsSpec = false
    child.unref()
  } catch {
    launchFailed = true
  } finally {
    if (out !== undefined) closeSync(out)
    if (ownsSpec) {
      try { unlinkSync(specPath) }
      catch (e) {
        if (e.code !== 'ENOENT') process.stderr.write('bg-task: cannot delete task specification\n')
      }
    }
  }
  if (launchFailed) die('cannot start background task', 1)

  console.log(`bg-task launched: name=${opts.name} id=${id} ttl=${opts.ttl}s`)
  console.log(`dir=${dir} (status, output.log, cmd)`)
  console.log('You will get interim checkpoints and a final result in this thread. Do not poll — end your turn.')
}
