#!/usr/bin/env node
// bg-task-runner.mjs — the detached half of bg-task. Never invoke directly; bg-task.mjs
// spawns it with `detached: true` so it outlives the agent session.
//
//   bg-task-runner.mjs <dir> <ttl> <name> <channel> <threadTs> <dry> <wakeDelay> -- <command...>
//
// Contract: run the command with a TTL, then send exactly one finish signal. Completion
// is EXPLICIT (this process reaching the enqueue step) — never inferred from the command
// producing output, because a task may legitimately sit silent for hours waiting on
// something external (an approval, an auth confirmation, a remote job).
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TAIL_BYTES = 1500
const KILL_GRACE_MS = 5000
const TIMEOUT_RC = 124 // same code GNU `timeout` uses, so docs and habits carry over
export const DEFAULT_WAKE_DELAY = 30 // seconds; see buildBody for why this is not 0

// Everything argv- and filesystem-related lives inside main() so this file can be
// imported by the tests without side effects.
export function parseRunnerArgs(argv) {
  const [dir, ttlArg, name, channel, threadTs, dry, wakeDelayArg] = argv.slice(0, 7)
  const sep = argv.indexOf('--', 7)
  return {
    dir,
    ttl: Number(ttlArg),
    name,
    channel,
    threadTs,
    dry,
    wakeDelay: Number(wakeDelayArg),
    cmd: sep === -1 ? [] : argv.slice(sep + 1),
  }
}

const stamp = () => new Date().toISOString()

// /proc/self/stat: pid (comm) state ppid pgrp session … — comm can contain spaces and
// parens, so split after the LAST ')'.
function sessionId() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[3] // state ppid pgrp session → index 3
  } catch {
    return ''
  }
}

// Last N bytes of the log. Decoded lossily on purpose: the tail may start mid-codepoint.
export function tailOf(path, bytes = TAIL_BYTES) {
  let fd
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
  }
}

// Count sibling task dirs that have not reached a terminal state, so the woken agent
// knows whether more wakes are coming instead of assuming this was the last one. Called
// with the task dir's parent, which is the per-channel namespace — so this never counts
// another brain's tasks even though the storage root is shared.
export function countRunningSiblings(root, selfDir) {
  try {
    return readdirSync(root)
      .map((d) => join(root, d))
      .filter((d) => d !== selfDir)
      .filter((d) => {
        try {
          return !/^state=/m.test(readFileSync(join(d, 'status'), 'utf8'))
        } catch {
          return false
        }
      }).length
  } catch {
    return 0
  }
}

export function buildPrompt({ name, state, rc, ttl, dir, tail, cmd = [], elapsedSec, siblings = 0 }) {
  const why = state === 'timed-out'
    ? `hit its ${ttl}s TTL and was killed`
    : `finished with exit code ${rc}`
  const elapsed = elapsedSec === undefined ? '' : `\nRan for: ${elapsedSec}s (TTL was ${ttl}s)`
  const also = siblings > 0
    ? `\n\nStill running: ${siblings} other background task${siblings === 1 ? '' : 's'} — expect further wake messages.`
    : ''
  return `A background task you launched in an earlier session has ${why}.

Task: ${name}
Command: ${cmd.join(' ') || '(unknown)'}
State: ${state} (rc=${rc})${elapsed}
Directory: ${dir}   (full output: ${join(dir, 'output.log')})

Last output:
${tail.trim() || '(no output)'}

Pick the work back up from here. Report the real outcome — if it failed or timed out,
say so instead of retrying blindly.${also}`
}

// POST /scheduled-messages with a ONE_TIME schedule is the only agent-reachable path
// that can wake an IDLE session (pb#231):
//   * POST /events is telemetry-only — a fixed whitelist of event types, writes a
//     pipeline row, never touches the message queue.
//   * dropping a file into .inbox/ is inject-if-running only; there is no filesystem
//     watcher, so a drained session never sees it.
// origin.channel must be explicit: it freezes at creation time (pb#124), and the
// launching session's environment is gone by the time the schedule fires.
export function buildBody({ prompt, channel, threadTs, env, now, wakeDelaySec = DEFAULT_WAKE_DELAY }) {
  const origin = { source: 'slack', channel }
  if (threadTs) origin.thread_ts = threadTs
  return {
    workspaceId: env.TEAMVIBE_WORKSPACE_ID,
    channelId: env.TEAMVIBE_CHANNEL_ID,
    scheduleType: 'ONE_TIME',
    // Deliberately NOT "now". The scheduler would accept it — it fires any row with
    // nextRunAt <= now on its ~1 min tick and does not validate that scheduledAt is in
    // the future — but that is not what the delay is for.
    //
    // The wake ALWAYS spawns a new session: scheduler.ts stamps its own threadId, so it
    // can never land inside the session that launched the task. Waking at "now" while
    // the launching session is still alive therefore buys a *guaranteed* two-sessions-
    // over-one-brain overlap instead of merely a likely one (teamvibe.ai#232 / #247).
    // The delay gives the launching session a moment to finish first.
    //
    // It is a damper, not a fix: sessions routinely live far longer than this, so the
    // overlap window is narrowed, never closed. Do not set it to 0 for latency.
    scheduledAt: new Date(now.getTime() + wakeDelaySec * 1000).toISOString(),
    promptTemplate: prompt,
    origin,
  }
}

async function main() {
  const { dir, ttl, name, channel, threadTs, dry, wakeDelay, cmd } = parseRunnerArgs(process.argv.slice(2))
  const statusPath = join(dir, 'status')
  const logPath = join(dir, 'output.log')
  const note = (lines) => appendFileSync(statusPath, lines.map((l) => `${l}\n`).join(''))

  const startedAt = Date.now()
  note([`started=${stamp()}`, `pid=${process.pid}`, `sid=${sessionId()}`, `ttl=${ttl}s`])

  const out = openSync(logPath, 'a')
  // detached so the command gets its own process group: on TTL we can then kill the
  // whole tree, not just the direct child (GNU timeout kills only the child).
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', out, out], detached: true })

  let timedOut = false
  let killTimer
  const ttlTimer = setTimeout(() => {
    timedOut = true
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }, KILL_GRACE_MS)
  }, ttl * 1000)

  const rc = await new Promise((resolve) => {
    child.on('error', (e) => {
      appendFileSync(logPath, `bg-task: cannot start command: ${e.message}\n`)
      resolve(127)
    })
    child.on('exit', (code, signal) => {
      if (timedOut) return resolve(TIMEOUT_RC)
      resolve(code === null ? 128 + (signal ? 1 : 0) : code)
    })
  })
  clearTimeout(ttlTimer)
  clearTimeout(killTimer)

  const state = rc === TIMEOUT_RC && timedOut ? 'timed-out' : 'finished'
  note([`state=${state}`, `rc=${rc}`, `ended=${stamp()}`])

  const body = buildBody({
    prompt: buildPrompt({
      name,
      state,
      rc,
      ttl,
      dir,
      tail: tailOf(logPath),
      cmd,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      siblings: countRunningSiblings(dirname(dir), dir),
    }),
    channel,
    threadTs,
    env: process.env,
    now: new Date(),
    wakeDelaySec: Number.isFinite(wakeDelay) ? wakeDelay : DEFAULT_WAKE_DELAY,
  })

  if (dry === '1') {
    writeFileSync(join(dir, 'enqueue.json'), JSON.stringify(body, null, 2))
    note([`dry_run=1 bytes=${JSON.stringify(body).length}`])
    return
  }

  // The response is the only evidence the wake was accepted; keep it verbatim in the
  // task dir. If this fails, the work is done but nobody is told — that is the
  // best-effort edge, and it must be visible here rather than silently dropped.
  try {
    const resp = await fetch(`${process.env.TEAMVIBE_API_URL}/scheduled-messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TEAMVIBE_POLLER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await resp.text()
    writeFileSync(join(dir, 'enqueue-response.json'), text)
    note([`enqueued=${stamp()}`, `http_status=${resp.status}`])
    if (!resp.ok) note([`enqueue_failed=1 reason=http_${resp.status}`])
  } catch (e) {
    note([`enqueue_failed=1 reason=${e.message}`])
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // A crash here means the command may have run but no one will be told. Record it
    // where the next reader looks, then fail loudly.
    try {
      const { dir } = parseRunnerArgs(process.argv.slice(2))
      appendFileSync(join(dir, 'status'), `runner_crashed=${stamp()}\nerror=${e.message}\n`)
    } catch { /* nothing left to do */ }
    console.error(`bg-task-runner crashed: ${e.stack || e.message}`)
    process.exit(1)
  })
}
