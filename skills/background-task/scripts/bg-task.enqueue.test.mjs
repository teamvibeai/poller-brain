#!/usr/bin/env node
// bg-task.enqueue.test.mjs — the enqueue matrix.
//
// The rest of the suite runs with --dry-run and never opens a socket, so it can only
// check the *shape* of the body. Everything that decides whether the wake will actually
// arrive happens after the POST, in how the response is read. This file drives the real
// runner against a stub API and asserts what ends up in the `status` file — the one
// artifact the agent (and `--list`) reads back.
//
// Written to run RED against the pre-fix runner on purpose: a test authored together
// with its fix cannot tell "this covers it" from "this passed by accident".
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'bg-task-runner.mjs')

let failures = 0
function check(label, condition, detail) {
  if (condition) return console.log(`  ok   ${label}`)
  failures++
  console.log(`  FAIL ${label}`)
  if (detail) console.log(`       status file: ${JSON.stringify(detail)}`)
}

// Stub API. `reply` decides the response for POST /scheduled-messages; a reply of null
// means "never answer" (the hung-server case).
function stubApi(reply) {
  const server = createServer((req, res) => {
    const answer = reply(req)
    if (!answer) return // hang: no response, no close
    setTimeout(() => {
      res.writeHead(answer.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    }, answer.delayMs || 0)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// Run the real runner to completion against `apiUrl` and return its status file.
function runRunner(apiUrl, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bg-enqueue-'))
  writeFileSync(join(dir, 'status'), '')
  const args = [RUNNER, dir, '30', 'matrix', 'C0TEST', '', '0', '30', '--', 'true']
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        TEAMVIBE_API_URL: apiUrl,
        TEAMVIBE_POLLER_TOKEN: 'test-token',
        TEAMVIBE_WORKSPACE_ID: 'W1',
        TEAMVIBE_CHANNEL_ID: 'CH1',
        ...extraEnv,
      },
    })
    // Bounded so a runner with no deadline of its own cannot hang the suite.
    const kill = setTimeout(() => { try { process.kill(child.pid, "SIGKILL") } catch { /* gone */ } }, 20000)
    child.on('exit', () => {
      clearTimeout(kill)
      resolve(readFileSync(join(dir, 'status'), 'utf8'))
    })
  })
}

const ACTIVE = { status: 200, body: { id: '01S', status: 'ACTIVE', nextRunAt: '2026-07-28T09:00:00.000Z' } }
// Accepted, stored, and dead on arrival: poller-scheduled-messages.ts marks a ONE_TIME
// row whose scheduledAt is already past as COMPLETED with GSI1PK=null. It returns 200
// and will never fire. This is the case the whole matrix exists for.
const COMPLETED = { status: 200, body: { id: '01S', status: 'COMPLETED', nextRunAt: null } }
const UNAUTHORIZED = { status: 401, body: { error: 'token expired' } }

const enqueueLine = (s) => (s.match(/^enqueue=(.*)$/m) || [])[1]

async function main() {
  console.log('enqueue matrix — 200-ACTIVE')
  {
    const { server, port } = await stubApi(() => ACTIVE)
    const status = await runRunner(`http://127.0.0.1:${port}`)
    server.close()
    check('a live schedule is recorded as an accepted enqueue', /^ok\b/.test(enqueueLine(status) || ''), status)
    check('no failure is recorded', !/enqueue=(failed|unknown)/.test(status), status)
  }

  console.log('enqueue matrix — 200 + COMPLETED (accepted, never fires)')
  {
    const { server, port } = await stubApi(() => COMPLETED)
    const status = await runRunner(`http://127.0.0.1:${port}`)
    server.close()
    // The load-bearing assertion: the difference between a wake and silence is one
    // field in the response body, not the HTTP code.
    check('a schedule that will never fire is NOT recorded as success',
      !/enqueue=ok/.test(status) && !/^enqueued=/m.test(status), status)
    check('the reason names the response field, not the transport',
      /^enqueue=failed:not_active/m.test(status), status)
  }

  console.log('enqueue matrix — 401 (token expired mid-TTL)')
  {
    const { server, port } = await stubApi(() => UNAUTHORIZED)
    const status = await runRunner(`http://127.0.0.1:${port}`)
    server.close()
    check('a rejected enqueue is a known failure', /^enqueue=failed:http_401/m.test(status), status)
  }

  console.log('enqueue matrix — API unreachable (connection refused)')
  {
    const { server, port } = await stubApi(() => ACTIVE)
    await new Promise((r) => server.close(r)) // free the port, then aim at it
    const status = await runRunner(`http://127.0.0.1:${port}`)
    check('a transport failure is unknown, not failed — the row may or may not exist',
      /^enqueue=unknown:/m.test(status), status)
    check('it is not claimed as a known failure', !/^enqueue=failed:/m.test(status), status)
  }

  console.log('enqueue matrix — server never answers (deadline)')
  {
    const { server, port } = await stubApi(() => null)
    const status = await runRunner(`http://127.0.0.1:${port}`, { BG_TASK_HTTP_TIMEOUT: '1' })
    server.close()
    check('the runner gives up instead of hanging forever', /^enqueue=unknown:/m.test(status), status)
  }

  console.log(failures === 0 ? '\nenqueue matrix: all green' : `\nenqueue matrix: ${failures} FAILING`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
