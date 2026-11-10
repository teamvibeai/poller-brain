import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const launcher = fileURLToPath(new URL('./bg-task.mjs', import.meta.url))
const sentinel = 'synthetic-secret-592-abcdefgh'
const read = file => existsSync(file) ? readFileSync(file, 'utf8') : ''
const lines = file => read(file).trim().split('\n').filter(Boolean).map(JSON.parse)
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bg-argv-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const audit = join(root, 'audit.jsonl'), preload = join(root, 'audit.mjs')
  writeFileSync(preload, `
    import { ChildProcess } from 'node:child_process'
    import { appendFileSync, readFileSync, statSync } from 'node:fs'
    const record = data => appendFileSync(process.env.AUDIT, JSON.stringify(data) + '\\n')
    if (process.argv[1]?.endsWith('/bg-task-runner.mjs')) {
      const file = process.argv[2]
      const spec = statSync(file).isFile() ? { mode: statSync(file).mode & 0o777, data: JSON.parse(readFileSync(file)) } : null
      record({ runner: process.argv, spec })
      process.on('exit', code => record({ exit: code }))
    }
    const original = ChildProcess.prototype.spawn
    ChildProcess.prototype.spawn = function(options) {
      record({ args: options.args })
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
    TEST_SECRET: sentinel, AUDIT: audit, RESULT: result,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  }
  const launch = args => spawnSync(process.execPath, [launcher, ...args], { cwd: root, env, encoding: 'utf8' })
  const done = async () => {
    const dir = join(env.BG_TASK_ROOT, 'TEST', readdirSync(join(env.BG_TASK_ROOT, 'TEST'))[0])
    for (let i = 0; i < 200; i++) {
      if (/^terminal_drop=/m.test(read(join(dir, 'status'))) && lines(audit).some(e => 'exit' in e)) return dir
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail('runner did not finish')
  }
  return { root, audit, workload, result, env, launch, done }
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
    const result = f.launch(['--', process.execPath, f.workload, arg])
    assert.equal(result.status, 0)
    const dir = await f.done(), events = lines(f.audit)
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
