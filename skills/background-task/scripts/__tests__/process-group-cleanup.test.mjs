import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { signalProcessGroup } from '../bg-task-runner.mjs'

const runner = fileURLToPath(new URL('../bg-task-runner.mjs', import.meta.url))
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : ''
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await sleep(10)
  }
  assert.fail('process did not reach the expected state')
}
function alive(pid) {
  try { process.kill(pid, 0) } catch (e) {
    if (e.code === 'ESRCH') return false
    throw e
  }
  // An adopted zombie cannot execute and cannot be killed again. Reaping belongs to
  // the host's init/subreaper; Linux CI containers do not all reap promptly.
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  assert.ifError(ps.error)
  return ps.status === 0 && !/^Z/.test(ps.stdout.trim())
}
function killGroup(pgid) {
  try { process.kill(-pgid, 'SIGKILL') } catch (e) { if (e.code !== 'ESRCH') throw e }
}
function fixture(t, mode, fault = '') {
  const dir = mkdtempSync(join(tmpdir(), 'bg-group-'))
  const pidFile = join(dir, 'descendant.json'), audit = join(dir, 'signals.jsonl')
  t.after(() => {
    const pgid = Number(/^workload_pgid=(\d+)$/m.exec(read(join(dir, 'status')))?.[1])
    if (pgid > 1) killGroup(pgid)
    rmSync(dir, { recursive: true, force: true })
  })
  const preload = join(dir, 'preload.mjs')
  writeFileSync(preload, `
    import fs from 'node:fs'
    if (process.argv[1] === ${JSON.stringify(runner)}) {
      const record = data => fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify(data) + '\\n')
      const kill = process.kill.bind(process)
      process.kill = (pid, signal) => {
        record({ pid, signal, terminal: /^state=/m.test(fs.existsSync(${JSON.stringify(join(dir, 'status'))}) ? fs.readFileSync(${JSON.stringify(join(dir, 'status'))}, 'utf8') : '') })
        if (${JSON.stringify(fault)} === 'EPERM') throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
        if (${JSON.stringify(fault)} === 'gone-on-term') {
          if (signal === 0) return true
          throw Object.assign(new Error('already gone'), { code: 'ESRCH' })
        }
        return kill(pid, signal)
      }
      const timeout = globalThis.setTimeout
      globalThis.setTimeout = (fn, ms, ...args) => {
        // Keep production constants unchanged. Only this runner process uses a
        // 150ms grace; TTL starts after the fixture's readiness handshake.
        if (ms === 5000) { record({ grace: ms }); return timeout(fn, 150, ...args) }
        if (ms === 1000 && ${JSON.stringify(mode)} === 'timeout') {
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(join(dir, 'leader-ready'))})) return
            clearInterval(timer)
            timeout(fn, 20, ...args)
          }, 5)
          return timer
        }
        return timeout(fn, ms, ...args)
      }
    }
  `)
  const grandchild = join(dir, 'grandchild.mjs'), middle = join(dir, 'middle.mjs'), leader = join(dir, 'leader.mjs')
  writeFileSync(grandchild, `
    import { writeFileSync } from 'node:fs'
    if (${JSON.stringify(mode)} === 'timeout') process.on('SIGTERM', () => writeFileSync(${JSON.stringify(join(dir, 'grandchild-term'))}, 'ignored'))
    writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, pgid: Number(process.env.GROUP_LEADER) }))
    process.send('ready')
    setInterval(() => {}, 1000)
  `)
  writeFileSync(middle, `
    import { spawn } from 'node:child_process'
    const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    child.on('message', () => process.send('ready', () => process.exit(0)))
  `)
  writeFileSync(leader, `
    import { spawn } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(join(dir, 'leader-term'))}, 'exited'); process.exit(7) })
    const child = spawn(process.execPath, [${JSON.stringify(middle)}], { env: { ...process.env, GROUP_LEADER: String(process.pid) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    child.on('exit', () => {
      writeFileSync(${JSON.stringify(join(dir, 'leader-ready'))}, 'ready')
      if (${JSON.stringify(mode)} === 'normal') process.exit(0)
      setInterval(() => {}, 1000)
    })
  `)
  const run = (cmd = [process.execPath, leader]) => {
    const spec = join(dir, 'spec.json')
    writeFileSync(spec, JSON.stringify({ dir, cmd, ttl: mode === 'timeout' ? 1 : 10, name: mode, threadId: 'BOT:CHANNEL:1.001', dryRun: true, quietCheckpoints: true, cwd: dir }))
    const result = spawnSync(process.execPath, [runner, spec], {
      cwd: dir, encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    return {
      status: read(join(dir, 'status')),
      signals: read(audit).trim().split('\n').filter(Boolean).map(JSON.parse),
      drops: read(join(dir, 'inbox-drops.jsonl')).trim().split('\n').filter(Boolean).map(JSON.parse),
    }
  }
  return { dir, pidFile, run }
}

test('normal leader exit cleans up a surviving grandchild before completion; foreign group survives', async t => {
  const f = fixture(t, 'normal')
  const foreignReady = join(f.dir, 'foreign-ready'), foreignTerm = join(f.dir, 'foreign-term')
  const foreign = spawn(process.execPath, ['-e', `
    const fs = require('node:fs')
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(foreignTerm)}, 'unexpected'))
    fs.writeFileSync(${JSON.stringify(foreignReady)}, 'ready')
    setInterval(() => {}, 1000)
  `], { detached: true, stdio: 'ignore' })
  t.after(async () => {
    killGroup(foreign.pid)
    await new Promise(resolve => foreign.exitCode !== null || foreign.signalCode !== null ? resolve() : foreign.once('exit', resolve))
  })
  await waitFor(() => existsSync(foreignReady))
  const result = f.run(), descendant = JSON.parse(read(f.pidFile))
  await waitFor(() => !alive(descendant.pid))
  assert.match(result.status, /^state=finished\nrc=0$/m)
  assert.match(result.status, new RegExp(`^workload_pgid=${descendant.pgid}$`, 'm'))
  assert.match(result.status, /^residual_descendants=found$/m)
  assert.match(result.status, /^residual_cleanup_signals=SIGTERM(?:,SIGKILL)?$/m)
  assert.equal(result.drops.length, 1)
  assert.match(result.drops[0].text, /Residual descendants: found; group cleanup sent SIGTERM/)
  const kills = result.signals.filter(e => e.signal)
  assert.ok(kills.some(e => e.signal === 'SIGTERM'))
  assert.ok(kills.every(e => e.pid === -descendant.pgid && !e.terminal))
  assert.equal(alive(foreign.pid), true)
  assert.equal(existsSync(foreignTerm), false)
})

test('TTL preserves escalation after TERM-exiting leader leaves a TERM-ignoring grandchild', async t => {
  const f = fixture(t, 'timeout'), result = f.run(), descendant = JSON.parse(read(f.pidFile))
  await waitFor(() => !alive(descendant.pid))
  assert.equal(read(join(f.dir, 'leader-term')), 'exited')
  assert.equal(read(join(f.dir, 'grandchild-term')), 'ignored')
  assert.match(result.status, /^state=timed-out\nrc=124$/m)
  assert.match(result.status, /^signal_sent=SIGTERM$/m)
  assert.match(result.status, /^child_rc=7$/m)
  assert.doesNotMatch(result.status, /^killed_by=/m)
  assert.match(result.status, /^residual_descendants=found$/m)
  assert.match(result.status, /^residual_cleanup_signals=SIGTERM,SIGKILL$/m)
  assert.deepEqual(result.signals.filter(e => e.signal).map(e => e.signal), ['SIGTERM', 'SIGKILL'])
  assert.equal(result.signals.filter(e => e.grace).length, 1, 'leader exit retains the original grace deadline')
  assert.ok(result.signals.filter(e => 'pid' in e).every(e => e.pid === -descendant.pgid && !e.terminal))
  assert.equal(result.drops.length, 1)
  assert.match(result.drops[0].text, /Residual descendants: found; group cleanup sent SIGTERM,SIGKILL/)
})

test('healthy workload completes with its exit code and no cleanup signals or grace', t => {
  const f = fixture(t, 'healthy'), result = f.run([process.execPath, '-e', 'process.exit(3)'])
  assert.match(result.status, /^state=finished\nrc=3$/m)
  assert.doesNotMatch(result.status, /residual_descendants|group_cleanup_error/)
  assert.ok(result.signals.every(e => e.signal === 0))
  assert.equal(result.drops.length, 1)
  assert.match(result.drops[0].text, /finished with exit code 3/)
  assert.doesNotMatch(result.drops[0].text, /Residual descendants/)
})

test('spawn failure has no process group and never attempts a signal', t => {
  const f = fixture(t, 'spawn-failure'), result = f.run([join(f.dir, 'missing-executable')])
  assert.match(result.status, /^state=finished\nrc=127$/m)
  assert.doesNotMatch(result.status, /workload_pgid|residual_descendants/)
  assert.deepEqual(result.signals, [])
  assert.equal(result.drops.length, 1)
})

test('EPERM keeps cleanup bounded and reports failure without claiming signals were delivered', t => {
  const f = fixture(t, 'permission', 'EPERM')
  const result = f.run([process.execPath, '-e', ''])
  assert.match(result.status, /^residual_descendants=found$/m)
  assert.match(result.status, /^group_cleanup_error=0:EPERM$/m)
  assert.match(result.status, /^group_cleanup_error=SIGTERM:EPERM$/m)
  assert.match(result.status, /^group_cleanup_error=SIGKILL:EPERM$/m)
  assert.match(result.status, /^residual_cleanup_signals=none$/m)
  assert.equal(result.drops.length, 1)
  assert.match(result.drops[0].text, /sent no signals; errors: 0:EPERM,SIGTERM:EPERM,SIGKILL:EPERM/)
})

test('ESRCH during cleanup is a harmless disappearance, with no delivered signals claimed', t => {
  const f = fixture(t, 'disappeared', 'gone-on-term')
  const result = f.run([process.execPath, '-e', ''])
  assert.match(result.status, /^residual_descendants=found$/m)
  assert.match(result.status, /^residual_cleanup_signals=none$/m)
  assert.doesNotMatch(result.status, /group_cleanup_error/)
  assert.deepEqual(result.signals.map(e => e.signal), [0, 'SIGTERM'], 'never revisit a pgid after ESRCH')
  assert.equal(result.drops.length, 1)
  assert.match(result.drops[0].text, /group cleanup sent no signals/)
})

test('group signaling rejects unsafe/missing ids and handles ESRCH/EPERM without fallback targets', () => {
  const calls = []
  const kill = (pid, signal) => { calls.push([pid, signal]); throw Object.assign(new Error('fixture'), { code: 'ESRCH' }) }
  for (const pgid of [undefined, null, NaN, 0, 1, -1, '123', 1.5]) {
    assert.deepEqual(signalProcessGroup(pgid, 'SIGKILL', kill), { error: 'invalid-pgid' })
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(signalProcessGroup(123, 0, kill), { gone: true })
  assert.deepEqual(calls, [[-123, 0]])
  for (const signal of [0, 'SIGTERM', 'SIGKILL']) {
    assert.deepEqual(signalProcessGroup(123, signal, (pid, sig) => {
      assert.equal(pid, -123)
      assert.equal(sig, signal)
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    }), { error: 'EPERM' })
  }
})
