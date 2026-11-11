import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const launcher = fileURLToPath(new URL('./bg-task.mjs', import.meta.url))
const runner = fileURLToPath(new URL('./bg-task-runner.mjs', import.meta.url))
const sentinel = 'synthetic-secret-592-abcdefgh'
const read = file => existsSync(file) ? readFileSync(file, 'utf8') : ''
const lines = file => read(file).trim().split('\n').filter(Boolean).map(JSON.parse)
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bg-argv-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const audit = join(root, 'audit.jsonl'), preload = join(root, 'audit.mjs')
  writeFileSync(preload, `
    import { ChildProcess } from 'node:child_process'
    import fs from 'node:fs'
    import { dirname, join } from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const record = data => fs.appendFileSync(process.env.AUDIT, JSON.stringify(data) + '\\n')
    const isRunner = process.argv[1]?.endsWith('/bg-task-runner.mjs')
    if (isRunner) {
      const file = process.argv[2]
      let spec = null
      try { spec = { mode: fs.statSync(file).mode & 0o777, data: JSON.parse(fs.readFileSync(file)) } } catch {}
      record({ runner: process.argv, spec })
      process.on('exit', code => record({ exit: code }))
    }
    if (process.argv[1] === process.env.WORKLOAD) process.on('exit', code => record({ workloadExit: code }))
    const originalRead = fs.readFileSync, originalUnlink = fs.unlinkSync, originalMkdir = fs.mkdirSync, originalWrite = fs.writeFileSync
    let inboxFailures = Number(process.env.INBOX_FAILURE_COUNT || 0)
    const failInbox = stage => {
      if (process.env.INBOX_FAILURE_STAGE !== stage || inboxFailures <= 0) return
      inboxFailures--
      if (stage === 'write' && process.env.INBOX_FAILURE_CODE === 'ENOENT') {
        // Match the watcher's bottom-up pruning of empty directories.
        fs.rmdirSync(process.env.TEST_INBOX_DIR)
        fs.rmdirSync(dirname(process.env.TEST_INBOX_DIR))
        fs.rmdirSync(dirname(dirname(process.env.TEST_INBOX_DIR)))
        return // Let the real write fail because its parent disappeared.
      }
      throw Object.assign(new Error('synthetic inbox ' + stage + ' failure'), { code: process.env.INBOX_FAILURE_CODE })
    }
    fs.readFileSync = function(file, ...args) {
      if (isRunner && process.env.FAIL_SPEC_READ && file === process.argv[2]) throw new Error('synthetic read failure')
      return originalRead.call(this, file, ...args)
    }
    fs.unlinkSync = function(file) {
      if (isRunner && file === process.env.FAIL_INPUT_DELETE) throw new Error('synthetic deletion failure')
      return originalUnlink.call(this, file)
    }
    fs.mkdirSync = function(file, options) {
      if (isRunner && file === process.env.TEST_INBOX_DIR) {
        record({ inboxMkdir: file })
        failInbox('mkdir')
      }
      if (!isRunner && process.env.TASK_COLLISION && dirname(file) === join(process.env.BG_TASK_ROOT, 'TEST')) {
        const kind = process.env.TASK_COLLISION, target = join(process.env.BG_TASK_ROOT, 'redirected')
        originalMkdir(dirname(file), { recursive: true })
        originalMkdir(target, { recursive: true })
        record({ collisionPath: file, target })
        if (kind === 'directory') originalMkdir(file)
        else if (kind === 'symlink') fs.symlinkSync(target, file)
        else {
          const result = originalMkdir(file, options)
          fs.renameSync(file, file + '-original')
          fs.symlinkSync(target, file)
          return result
        }
      }
      return originalMkdir(file, options)
    }
    fs.writeFileSync = function(file, ...args) {
      if (isRunner && dirname(file) === process.env.TEST_INBOX_DIR) {
        record({ inboxWrite: file })
        failInbox('write')
        const result = originalWrite.call(this, file, ...args)
        record({ inboxWritten: file })
        return result
      }
      return originalWrite.call(this, file, ...args)
    }
    syncBuiltinESMExports()
    const original = ChildProcess.prototype.spawn
    ChildProcess.prototype.spawn = function(options) {
      record({ args: options.args, inputExists: process.env.INPUT_FILE ? fs.existsSync(process.env.INPUT_FILE) : null })
      if (!isRunner && process.env.FAIL_RUNNER_SPAWN && options.args.some(arg => arg.endsWith('/bg-task-runner.mjs'))) {
        if (process.env.FAIL_RUNNER_SPAWN === 'sync') throw new Error('synthetic spawn failure')
        process.nextTick(() => this.emit('error', new Error('synthetic async spawn failure')))
        return this
      }
      return original.call(this, options)
    }
  `)
  const workload = join(root, 'workload.mjs'), result = join(root, 'result.json')
  writeFileSync(workload, `
    import { readFileSync, writeFileSync } from 'node:fs'
    const input = readFileSync(0, 'utf8')
    writeFileSync(process.env.RESULT, JSON.stringify({ delivered: input === process.env.TEST_SECRET, argv: process.argv, cwd: process.cwd() }))
    console.log('workload complete')
  `)
  const env = {
    PATH: process.env.PATH, BG_TASK_ROOT: join(root, 'tasks'), BG_TASK_DRY: '1',
    TEAMVIBE_CHANNEL_ID: 'TEST', INBOX_THREAD_ID: 'BOT:CHANNEL:1.001',
    TEST_SECRET: sentinel, AUDIT: audit, RESULT: result, WORKLOAD: workload,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  }
  const launch = args => spawnSync(process.execPath, [launcher, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
  const direct = (cmd, overrides = {}, raw) => {
    const dir = join(env.BG_TASK_ROOT, 'TEST', 'direct'), specPath = join(dir, 'spec.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(specPath, raw ?? JSON.stringify({
      dir, cmd, ttl: 30, name: 'direct', threadId: env.INBOX_THREAD_ID, dryRun: true, cwd: root, ...overrides,
    }), { mode: 0o600 })
    return { dir, specPath, ...spawnSync(process.execPath, [runner, specPath], { cwd: root, env, encoding: 'utf8', timeout: 10000 }) }
  }
  const settleWorkload = async () => {
    if (!lines(audit).some(e => e.args?.includes(workload))) return
    for (let i = 0; i < 200; i++) {
      if (lines(audit).some(e => 'workloadExit' in e)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail('workload did not finish')
  }
  const done = async () => {
    const dir = join(env.BG_TASK_ROOT, 'TEST', readdirSync(join(env.BG_TASK_ROOT, 'TEST'))[0])
    for (let i = 0; i < 200; i++) {
      if (/^terminal_drop=/m.test(read(join(dir, 'status'))) && lines(audit).some(e => 'exit' in e)) return dir
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail('runner did not finish')
  }
  return { root, audit, workload, result, env, launch, direct, settleWorkload, done }
}

for (const stage of ['write', 'mkdir']) {
  for (const [code, failures, delivered, attempts] of [
    ['ENOENT', 1, true, 2],
    ['ENOENT', 10, false, 5],
    ['EACCES', 1, false, 1],
  ]) {
    test(`inbox drop: ${stage} ${code} (${failures} failures) ${delivered ? 'recovers exactly once' : 'surfaces failure'}`, t => {
      const f = fixture(t), inboxDir = join(f.root, '.inbox', f.env.INBOX_THREAD_ID, 'new')
      Object.assign(f.env, {
        POLLER_BRAIN_PATH: f.root, TEST_INBOX_DIR: inboxDir,
        INBOX_FAILURE_STAGE: stage, INBOX_FAILURE_CODE: code, INBOX_FAILURE_COUNT: String(failures),
      })
      const result = f.direct([process.execPath, '-e', ''], { dryRun: false })
      assert.equal(result.status, 0, result.stderr)
      const events = lines(f.audit), status = read(join(result.dir, 'status'))
      if (delivered) assert.match(status, /^terminal_drop=ok$/m)
      else assert.match(status, /^terminal_drop=FAILED:/m)
      assert.equal(events.filter(e => e.inboxMkdir).length, attempts)
      const writes = events.filter(e => e.inboxWrite).map(e => e.inboxWrite)
      assert.equal(writes.length, stage === 'mkdir' ? (delivered ? 1 : 0) : attempts)
      assert.equal(new Set(writes).size, writes.length ? 1 : 0, 'retries keep the same filename')
      assert.equal(events.filter(e => e.inboxWritten).length, delivered ? 1 : 0)
      assert.equal(existsSync(join(result.dir, 'inbox-drops.jsonl')), false, 'real drops are not diverted')
      const files = existsSync(inboxDir) ? readdirSync(inboxDir) : []
      assert.equal(files.length, delivered ? 1 : 0)
      if (delivered) {
        assert.match(files[0], /^\d+\.txt$/)
        const payload = JSON.parse(read(join(inboxDir, files[0])))
        assert.match(payload.text, /finished with exit code 0/)
        assert.deepEqual({ ...payload, text: '' }, {
          text: '', sender: { id: 'system', name: 'Background Task' },
          type: 'message', source: 'slack', attachments: [],
        })
      } else {
        assert.match(status, new RegExp(stage === 'write' && code === 'ENOENT' ? 'ENOENT' : `synthetic inbox ${stage} failure`))
      }
    })
  }
}

test('runner gets only a private spec path; existing launch and --list still work', async t => {
  const f = fixture(t)
  const result = f.launch(['--name', 'legacy', '--ttl', '30', '--note', sentinel, '--', process.execPath, f.workload])
  assert.equal(result.status, 0)
  const dir = await f.done(), events = lines(f.audit), runner = events.find(e => e.runner)
  assert.equal(runner.runner.length, 3, 'runner argv contains only interpreter, script and spec path')
  assert.equal(runner.spec.mode, 0o600)
  assert.equal(runner.spec.data.cwd, f.root)
  assert.equal(runner.spec.data.note, sentinel)
  assert.ok(runner.spec.data.envNames.includes('TEST_SECRET'))
  assert.ok(!JSON.stringify(runner.spec.data).includes(`"TEST_SECRET":"${sentinel}"`))
  assert.ok(!JSON.stringify(events.filter(e => e.args)).includes(sentinel))
  assert.ok(!runner.runner.includes(f.workload))
  assert.match(read(join(dir, 'status')), /^rc=0$/m)
  const list = f.launch(['--list'])
  assert.equal(list.status, 0)
  assert.match(list.stdout, /legacy\s+finished\s+0/)
})

test('workload receives secret stdin, input file is removed, argv stays clean', async t => {
  const f = fixture(t), input = join(f.root, 'prompt.txt')
  writeFileSync(input, sentinel, { mode: 0o600 })
  const result = f.launch(['--stdin-file', input, '--', process.execPath, f.workload])
  assert.equal(result.status, 0, 'stdin-file launch is accepted')
  await f.done()
  assert.equal(existsSync(input), false)
  const received = JSON.parse(read(f.result))
  assert.equal(received.delivered, true)
  assert.equal(received.cwd, f.root)
  assert.ok(!JSON.stringify(lines(f.audit).filter(e => e.args || e.runner).map(e => e.args || e.runner)).includes(sentinel))
  assert.ok(!JSON.stringify(received.argv).includes(sentinel))
})

for (const [name, arg] of [
  ['TEST_TOKEN', sentinel], ['test_secret', `header: Bearer ${sentinel}`],
  ['API_KEY', `echo ${sentinel}`], ['PASSWORD', sentinel],
]) {
  test(`refuses final argv containing ${name} without spawning or printing its value`, async t => {
    const f = fixture(t)
    delete f.env.TEST_SECRET
    f.env[name] = sentinel
    // Invoke the runner directly so its independent admission check stays covered.
    const result = f.direct([process.execPath, f.workload, arg])
    assert.equal(result.status, 2)
    const dir = result.dir, events = lines(f.audit)
    assert.match(read(join(dir, 'status')), /^rc=2$/m)
    assert.equal(events.find(e => 'exit' in e).exit, 2)
    assert.equal(existsSync(f.result), false, 'unsafe workload never spawned')
    const diagnostic = result.stdout + result.stderr + read(join(dir, 'runner.stdout')) + read(join(dir, 'output.log')) + read(join(dir, 'inbox-drops.jsonl'))
    assert.match(diagnostic, new RegExp(name))
    assert.ok(!diagnostic.includes(sentinel), 'diagnostics and terminal drop must not print the secret')
    assert.ok(!JSON.stringify(events.filter(e => e.args || e.runner).map(e => e.args || e.runner)).includes(sentinel))
  })
}

test('short values and non-secret environment names do not block ordinary argv', async t => {
  const f = fixture(t)
  delete f.env.TEST_SECRET
  f.env.SHORT_TOKEN = 'short'
  f.env.ORDINARY = sentinel
  assert.equal(f.launch(['--', process.execPath, f.workload, 'short', sentinel]).status, 0)
  const dir = await f.done()
  assert.match(read(join(dir, 'status')), /^rc=0$/m)
})

for (const name of ['TEAMVIBE_POLLER_TOKEN', 'ADAPTER_SECRET']) {
  test(`review1 P1: launcher refuses ${name} from original env before any spawn`, async t => {
    const f = fixture(t), adapter = join(f.root, 'adapter.mjs')
    f.env[name] = sentinel
    delete f.env.TEST_SECRET
    writeFileSync(adapter, `
      import { spawn } from 'node:child_process'
      import { appendFileSync } from 'node:fs'
      export function spawnBackgroundTask(command, args, options) {
        appendFileSync(process.env.AUDIT, JSON.stringify({ adapterCalled: true }) + '\\n')
        const env = { ...options.env }
        delete env.TEAMVIBE_POLLER_TOKEN
        delete env.ADAPTER_SECRET
        return spawn(command, args, { ...options, env })
      }
    `)
    f.env.TV_GIT_BG_TASK_LAUNCHER = pathToFileURL(adapter).href
    const result = f.launch(['--', process.execPath, f.workload, `Bearer ${sentinel}`])
    if (result.status === 0) await f.done() // Let vulnerable sources finish their own child.
    assert.equal(result.status, 2, 'launcher must refuse before env stripping')
    assert.match(result.stderr, new RegExp(name))
    assert.ok(!(result.stdout + result.stderr).includes(sentinel))
    assert.deepEqual(lines(f.audit), [], 'no adapter or runner may start')
    assert.equal(existsSync(f.env.BG_TASK_ROOT), false)
  })
}

test('review1 P2: stdin file is deleted before the workload spawn', async t => {
  const f = fixture(t), input = join(f.root, 'input')
  f.env.INPUT_FILE = input
  writeFileSync(input, sentinel)
  const result = f.direct([process.execPath, f.workload], { stdinFile: input })
  await f.settleWorkload()
  assert.equal(result.status, 0)
  assert.equal(lines(f.audit).find(e => e.args?.includes(f.workload)).inputExists, false)
  assert.equal(JSON.parse(read(f.result)).delivered, true)
})

test('review1 P2: stdin deletion failure records terminal failure and wake without a child', async t => {
  const f = fixture(t), input = join(f.root, 'input')
  writeFileSync(input, sentinel)
  f.env.FAIL_INPUT_DELETE = input
  const result = f.direct([process.execPath, f.workload], { stdinFile: input })
  await f.settleWorkload()
  assert.equal(result.status, 2, 'deletion failure must be a clean refusal')
  assert.match(read(join(result.dir, 'status')), /^state=finished\nrc=2$/m)
  assert.match(read(join(result.dir, 'status')), /^terminal_drop=diverted$/m)
  assert.equal(lines(join(result.dir, 'inbox-drops.jsonl')).length, 1)
  assert.match(read(join(result.dir, 'output.log')), /cannot delete --stdin-file/)
  assert.ok(!lines(f.audit).some(e => e.args?.includes(f.workload)))
  assert.equal(existsSync(f.result), false)
})

for (const kind of ['directory', 'symlink', 'replaced-symlink']) {
  test(`review1 P3: reject task path ${kind} before writing spec or spawning`, async t => {
    const f = fixture(t)
    f.env.TASK_COLLISION = kind
    const result = f.launch(['--', process.execPath, f.workload])
    if (result.status === 0) await f.done()
    assert.equal(result.status, 1, 'task directory must be created exclusively and lstat checked')
    assert.match(result.stderr, /cannot create task directory/)
    assert.ok(!lines(f.audit).some(e => e.args))
    const collision = lines(f.audit).find(e => e.collisionPath)
    assert.deepEqual(readdirSync(collision.target), [], 'no artifacts may be redirected')
    assert.equal(existsSync(join(collision.collisionPath, 'spec.json')), false)
  })
}

for (const failure of ['parse', 'read']) {
  test(`review1 P4: runner deletes spec on ${failure} failure`, async t => {
    const f = fixture(t)
    if (failure === 'read') f.env.FAIL_SPEC_READ = '1'
    const result = f.direct([process.execPath, f.workload], {}, failure === 'parse' ? '{invalid json' : undefined)
    assert.equal(existsSync(result.specPath), false, 'handled spec failures must remove the private handoff')
    assert.equal(result.status, 1)
    assert.ok(!lines(f.audit).some(e => e.args?.includes(f.workload)))
  })
}

for (const failure of ['sync', 'async']) {
  test(`review1 P4: launcher deletes spec on ${failure} spawn failure`, t => {
    const f = fixture(t)
    f.env.FAIL_RUNNER_SPAWN = failure
    const result = f.launch(['--', process.execPath, f.workload])
    const attempt = lines(f.audit).find(e => e.args?.includes(runner))
    assert.ok(attempt, 'runner launch was attempted')
    assert.equal(existsSync(attempt.args.at(-1)), false, 'launcher owns cleanup until the spawn succeeds')
    assert.equal(result.status, 1)
    assert.ok(!lines(f.audit).some(e => e.runner))
    assert.ok(!(result.stdout + result.stderr).includes(sentinel))
  })
}
