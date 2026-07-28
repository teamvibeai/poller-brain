// Tests for bg-task.mjs / bg-task-runner.mjs. Same style as mcp/__tests__ — plain node,
// hand-rolled counters, no framework, no network. Every launch runs with --dry-run, so
// nothing is ever POSTed to the API.
//
//   node bg-task.test.mjs                    # fast cases (~5 s)
//   BG_TASK_TEST_SLOW=1 node bg-task.test.mjs   # + real TTL-kill case (~35 s)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = join(HERE, 'bg-task.mjs')

const { parseArgs, taskId } = await import(join(HERE, 'bg-task.mjs'))
const { buildPrompt, buildBody, tailOf, countRunningSiblings, parseRunnerArgs } =
  await import(join(HERE, 'bg-task-runner.mjs'))

let pass = 0, fail = 0
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n) }
  else { fail++; console.log('  ✗ FAIL', n, extra !== undefined ? `— ${extra}` : '') }
}
const eq = (n, got, want) => ok(n, got === want, `expected [${want}], got [${got}]`)
const has = (n, hay, needle) => ok(n, String(hay).includes(needle), `[${needle}] not in: ${String(hay).slice(0, 200)}`)

const WORK = mkdtempSync(join(tmpdir(), 'bgtask-'))
const ROOT = join(WORK, 'tasks')
// Task dirs are namespaced per channel under the root (shared poller storage).
const ROOT_NS = join(ROOT, '01TESTCHANNEL')
const ENV = {
  ...process.env,
  BG_TASK_ROOT: ROOT,
  BG_TASK_DRY: '1',
  TEAMVIBE_API_URL: 'https://example.invalid',
  TEAMVIBE_POLLER_TOKEN: 'test-token',
  TEAMVIBE_WORKSPACE_ID: '01TESTWORKSPACE',
  TEAMVIBE_CHANNEL_ID: '01TESTCHANNEL',
  SLACK_CHANNEL: 'C0TEST',
  SLACK_THREAD_TS: '',
}

function launch(args, envOverride = {}) {
  try {
    const stdout = execFileSync(process.execPath, [LAUNCHER, ...args], {
      env: { ...ENV, ...envOverride }, encoding: 'utf8',
    })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const latestDir = () => {
  const dirs = readdirSync(ROOT_NS).map((d) => join(ROOT_NS, d))
  return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}
async function waitDone(dir, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const s = existsSync(join(dir, 'status')) ? readFileSync(join(dir, 'status'), 'utf8') : ''
    if (/^state=/m.test(s)) return s
    await sleep(200)
  }
  return null
}

// --- pure units --------------------------------------------------------------------
console.log('parseArgs')
{
  eq('no command → error', !!parseArgs(['--name', 'x'], ENV).error, true)
  eq('unknown flag → error', !!parseArgs(['--nope', '--', 'true'], ENV).error, true)
  eq('flag without value → error', !!parseArgs(['--ttl'], ENV).error, true)
  has('non-numeric ttl names the flag', parseArgs(['--ttl', 'abc', '--', 'true'], ENV).error, '--ttl must be an integer')
  has('ttl below floor names the bounds', parseArgs(['--ttl', '10', '--', 'true'], ENV).error, 'between 30 and 21600')
  has('ttl above ceiling names the bounds', parseArgs(['--ttl', '99999', '--', 'true'], ENV).error, 'between 30 and 21600')
  has('no channel names the fix', parseArgs(['--', 'true'], {}).error, '--channel')

  const { opts } = parseArgs(['--name', 'b', '--ttl', '60', '--', 'echo', 'a b'], ENV)
  eq('defaults + cmd survive parsing', JSON.stringify(opts.cmd), JSON.stringify(['echo', 'a b']))
  eq('ttl coerced to number', opts.ttl, 60)
  eq('channel defaults from SLACK_CHANNEL', opts.channel, 'C0TEST')
  eq('thread defaults from SLACK_THREAD_TS', parseArgs(['--', 'true'], { ...ENV, SLACK_THREAD_TS: '123.456' }).opts.thread, '123.456')
  eq('--thread overrides env', parseArgs(['--thread', '9.9', '--', 'true'], { ...ENV, SLACK_THREAD_TS: '123.456' }).opts.thread, '9.9')
  eq('-- separates flags from a command that has its own flags',
    JSON.stringify(parseArgs(['--', 'ls', '--color'], ENV).opts.cmd), JSON.stringify(['ls', '--color']))
}

console.log('taskId')
{
  const id = taskId('my build!', 42, new Date('2026-07-28T08:01:02.500Z'))
  eq('unsafe chars replaced, stamp + pid kept', id, '20260728T080102Z-42-my_build_')
}

console.log('buildPrompt')
{
  const p = buildPrompt({ name: 'b', state: 'finished', rc: 0, ttl: 60, dir: '/d', tail: 'out' })
  has('finish wording carries the code', p, 'finished with exit code 0')
  has('prompt points at the full log', p, '/d/output.log')
  has('prompt tells the agent to report the real outcome', p, 'instead of retrying blindly')
  const t = buildPrompt({ name: 'b', state: 'timed-out', rc: 124, ttl: 60, dir: '/d', tail: '' })
  has('timeout wording says killed', t, 'hit its 60s TTL and was killed')
  has('empty tail is stated, not omitted', t, '(no output)')
}

console.log('buildPrompt — what the woken agent needs beyond the outcome (canary feedback)')
{
  const p = buildPrompt({
    name: 'b', state: 'finished', rc: 0, ttl: 900, dir: '/d', tail: 'x',
    cmd: ['npm', 'run', 'build'], elapsedSec: 240, siblings: 2,
  })
  has('prompt carries the command that was run', p, 'Command: npm run build')
  has('prompt carries elapsed time and the TTL it ran against', p, 'Ran for: 240s (TTL was 900s)')
  has('prompt warns that more wakes are coming', p, 'Still running: 2 other background tasks')
  const solo = buildPrompt({ name: 'b', state: 'finished', rc: 0, ttl: 60, dir: '/d', tail: 'x', cmd: ['true'] })
  ok('no sibling line when nothing else runs', !solo.includes('Still running'), solo)
  ok('no elapsed line when unknown', !solo.includes('Ran for:'), solo)
  has('single sibling is singular', buildPrompt({ name: 'b', state: 'finished', rc: 0, ttl: 60, dir: '/d', tail: '', siblings: 1 }),
    '1 other background task —')
}

console.log('countRunningSiblings')
{
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const root = join(WORK, 'siblings')
  for (const [d, status] of [['a', 'started=x\nstate=finished\nrc=0\n'], ['b', 'started=x\n'], ['c', 'started=x\n']]) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, 'status'), status)
  }
  mkdirSync(join(root, 'nostatus'), { recursive: true })
  eq('counts only dirs without a terminal state', countRunningSiblings(root, join(root, 'b')), 1)
  eq('excludes self', countRunningSiblings(root, join(root, 'c')), 1)
  eq('a dir with no status file is not counted', countRunningSiblings(root, join(root, 'zzz')), 2)
  eq('missing root → 0, no throw', countRunningSiblings(join(WORK, 'nope'), 'x'), 0)
}

console.log('parseRunnerArgs')
{
  const r = parseRunnerArgs(['/d', '60', 'n', 'C1', '111.222', '0', '30', '--', 'echo', '--weird'])
  eq('command after -- survives, including its own flags', JSON.stringify(r.cmd), JSON.stringify(['echo', '--weird']))
  eq('empty threadTs stays empty', parseRunnerArgs(['/d', '60', 'n', 'C1', '', '0', '30', '--', 'true']).threadTs, '')
  eq('ttl coerced', r.ttl, 60)
  eq('wakeDelay coerced', r.wakeDelay, 30)
}

console.log('buildBody')
{
  const now = new Date('2026-07-28T08:00:00.000Z')
  const b = buildBody({ prompt: 'p', channel: 'C1', threadTs: '', env: ENV, now })
  eq('schedule is ONE_TIME', b.scheduleType, 'ONE_TIME')
  // Regression pin: the wake must NOT be scheduled at `now`. The delay gives the
  // launching session time to finish, otherwise the overlap is guaranteed rather than
  // likely (teamvibe.ai#247). Dropped once during the bash->Node port; this catches it.
  eq('scheduledAt is delayed by default 30 s, not now', b.scheduledAt, '2026-07-28T08:00:30.000Z')
  const delayed = buildBody({ prompt: 'p', channel: 'C1', threadTs: '', env: ENV, now, wakeDelaySec: 90 })
  eq('wakeDelaySec is honoured', delayed.scheduledAt, '2026-07-28T08:01:30.000Z')
  eq('origin.channel is explicit', b.origin.channel, 'C1')
  eq('no thread_ts key when not requested', 'thread_ts' in b.origin, false)
  eq('workspace + channel come from env', `${b.workspaceId}/${b.channelId}`, '01TESTWORKSPACE/01TESTCHANNEL')
  eq('no cron field on a ONE_TIME body', 'cronExpression' in b, false)
  const withThread = buildBody({ prompt: 'p', channel: 'C1', threadTs: '111.222', env: ENV, now })
  eq('thread_ts included when given', withThread.origin.thread_ts, '111.222')
}

console.log('tailOf')
{
  const f = join(WORK, 'tail.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(f, 'x'.repeat(2000) + 'THEEND')

  const t = tailOf(f, 100)
  eq('reads only the last N bytes', t.length, 100)
  has('tail keeps the end of the file', t, 'THEEND')
  eq('missing file → empty string, no throw', tailOf(join(WORK, 'nope.txt')), '')

  // Default cap: a chatty task must not push a multi-MB log into the wake payload.
  writeFileSync(f, 'A'.repeat(50000) + 'TAIL-MARKER')
  const capped = tailOf(f)
  eq('default cap is 1500 bytes', capped.length, 1500)
  has('the END of a long log survives, not the start', capped, 'TAIL-MARKER')
  ok('the start of a long log is dropped', !capped.startsWith('A'.repeat(1500)) || capped.includes('TAIL-MARKER'), capped.slice(0, 40))

  const short = join(WORK, 'short.txt')
  writeFileSync(short, 'tiny')
  eq('a file shorter than the cap is returned whole', tailOf(short), 'tiny')
  writeFileSync(short, '')
  eq('an empty file → empty string', tailOf(short), '')
}

// --- end-to-end (detached runner, dry-run) -----------------------------------------
console.log('launch validation')
{
  const r = launch(['--ttl', '10', '--', 'true'])
  eq('bad ttl exits 2', r.code, 2)
  has('error goes to stderr with a prefix', r.stderr, 'bg-task: --ttl must be')
  has('usage is printed on a usage error', r.stderr, 'usage: bg-task.mjs')

  const noEnv = launch(['--', 'true'], { TEAMVIBE_POLLER_TOKEN: '' })
  eq('missing env exits 2', noEnv.code, 2)
  has('missing env names the variable', noEnv.stderr, 'TEAMVIBE_POLLER_TOKEN')
}

console.log('finish path')
{
  const r = launch(['--name', 'unit-ok', '--ttl', '60', '--', 'echo', 'CANARY-OK'])
  eq('launch exits 0', r.code, 0)
  has('launch prints the task name', r.stdout, 'bg-task launched: name=unit-ok')
  has('launch tells the agent not to poll', r.stdout, 'Do not poll')

  // Shared poller storage: two brains must not land in the same directory.
  has('task dir is namespaced by channel id', r.stdout, join(ROOT, '01TESTCHANNEL'))
  ok('nothing is created directly in the shared root',
    readdirSync(ROOT).every((e) => e === '01TESTCHANNEL'), readdirSync(ROOT).join(','))

  const dir = latestDir()
  const status = await waitDone(dir)
  ok('runner reached a terminal state', !!status, 'no state= line in status')
  if (status) {
    has('state=finished on clean exit', status, 'state=finished')
    has('rc=0 recorded', status, 'rc=0')
    has('dry run does not POST', status, 'dry_run=1')
    has('command output captured', readFileSync(join(dir, 'output.log'), 'utf8'), 'CANARY-OK')
    has('cmd file records the argv', readFileSync(join(dir, 'cmd'), 'utf8'), 'CANARY-OK')

    // The load-bearing property: the runner is in its own session, which is why the
    // spawner killing the session's process group at teardown cannot reach it.
    const runnerSid = /^sid=(\d+)$/m.exec(status)?.[1]
    const mySid = readFileSync('/proc/self/stat', 'utf8')
    const myFields = mySid.slice(mySid.lastIndexOf(')') + 2).split(' ')
    ok('runner runs in its own session', !!runnerSid && runnerSid !== myFields[3],
      `runner sid=${runnerSid} launcher sid=${myFields[3]}`)

    const body = JSON.parse(readFileSync(join(dir, 'enqueue.json'), 'utf8'))
    eq('enqueue body is ONE_TIME', body.scheduleType, 'ONE_TIME')
    eq('enqueue body has explicit origin.channel', body.origin.channel, 'C0TEST')
    has('prompt carries the task name', body.promptTemplate, 'unit-ok')
    has('prompt carries the output tail', body.promptTemplate, 'CANARY-OK')
  }
}

console.log('non-zero exit is a finish, not a timeout')
{
  eq('launch exits 0', launch(['--name', 'unit-fail', '--ttl', '60', '--', 'false']).code, 0)
  const status = await waitDone(latestDir())
  has('state=finished', status || '', 'state=finished')
  has('rc=1', status || '', 'rc=1')
}

console.log('unstartable command is reported, not silent')
{
  eq('launch exits 0', launch(['--name', 'unit-enoent', '--ttl', '60', '--', '/nonexistent-binary-xyz']).code, 0)
  const dir = latestDir()
  const status = await waitDone(dir)
  has('rc=127 for a command that cannot start', status || '', 'rc=127')
  has('reason lands in the log', readFileSync(join(dir, 'output.log'), 'utf8'), 'cannot start command')
}

console.log('--channel and --thread reach the wake payload')
{
  eq('launch exits 0', launch(['--name', 'unit-chan', '--ttl', '60', '--channel', 'C0OTHER', '--thread', '77.88', '--', 'true']).code, 0)
  const dir = latestDir()
  await waitDone(dir)
  const body = JSON.parse(readFileSync(join(dir, 'enqueue.json'), 'utf8'))
  eq('origin.channel uses the override', body.origin.channel, 'C0OTHER')
  eq('origin.thread_ts uses the override', body.origin.thread_ts, '77.88')
}

if (process.env.BG_TASK_TEST_SLOW === '1') {
  console.log('TTL kill (slow: ~35 s)')
  eq('launch exits 0', launch(['--name', 'unit-ttl', '--ttl', '30', '--', 'sleep', '300']).code, 0)
  const dir = latestDir()
  const status = await waitDone(dir, 250)
  has('state=timed-out', status || '', 'state=timed-out')
  has('rc=124', status || '', 'rc=124')
  has('prompt says it was killed', readFileSync(join(dir, 'enqueue.json'), 'utf8'), 'hit its 30s TTL and was killed')
} else {
  console.log('TTL kill — skipped (set BG_TASK_TEST_SLOW=1 to run it)')
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
