// Run: node mcp/__tests__/teamvibe-api-search-history.test.mjs
// HISTORY_SEARCH_BASELINE=1 loads git show's server into a temporary file.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const output = process.stdout.write.bind(process.stdout)
const root = fs.mkdtempSync(join(tmpdir(), 'history-search-'))
const mcpDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'history', 'TC1.sqlite')
const contextDir = join(root, 'brain', '.inbox', 'B1:CSESSION:1.1')
const contextPath = join(contextDir, 'context.json')
const originalEnv = { ...process.env }
const realFetch = globalThis.fetch
const originalStdout = process.stdout.write
const originalStderr = process.stderr.write
const originalConsole = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug', 'trace', 'dir'].map(k => [k, console[k]]))
const logs = []
let calls = [], reply, module, sequence = 0
const baseline = process.env.HISTORY_SEARCH_BASELINE === '1'
const check = (condition, label) => { assert.ok(condition, label); pass++ }
async function test(label, fn) {
  try { await fn(); output(`  ✓ ${label}\n`) }
  catch (e) { fail++; output(`  ✗ ${label}: ${e.code === 'ERR_ASSERTION' ? e.message : 'unexpected exception'}\n`) }
}
const context = (id = 'U00001') => fs.writeFileSync(contextPath, JSON.stringify({ sender: { id, name: 'x' } }))
const reset = () => {
  calls = []
  context()
  process.env.INBOX_THREAD_ID = 'B1:CSESSION:1.1'
  process.env.POLLER_BRAIN_PATH = join(root, 'brain')
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  process.env.SLACK_CHANNEL = 'CSESSION'
  module?.historyGuardCache.clear()
  reply = async ({ method }) => ({ ok: true, json: async () => method === 'conversations.info'
    ? { ok: true, channel: { is_member: true } } : { ok: true, members: ['U00001'] } })
}
const digest = () => createHash('sha256').update(fs.readFileSync(path)).digest('hex')
const sideFiles = () => fs.readdirSync(dirname(path)).filter(x => /-(wal|journal|shm)$/.test(x))

// Writer schema v1, verbatim.
const DDL = `CREATE TABLE IF NOT EXISTS messages (
  channel TEXT NOT NULL, ts TEXT NOT NULL, thread_ts TEXT NOT NULL,
  user_id TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
  attachment_names TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK(source IN ('inbound','outbound','history')),
  first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel,ts));
CREATE INDEX IF NOT EXISTS messages_thread ON messages(channel,thread_ts);
CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(text, attachment_names, content='messages',
  content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO history(rowid,text,attachment_names) VALUES(new.rowid,new.text,new.attachment_names);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO history(history,rowid,text,attachment_names) VALUES('delete',old.rowid,old.text,old.attachment_names);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text,attachment_names ON messages BEGIN
  INSERT INTO history(history,rowid,text,attachment_names) VALUES('delete',old.rowid,old.text,old.attachment_names);
  INSERT INTO history(rowid,text,attachment_names) VALUES(new.rowid,new.text,new.attachment_names);
END;
PRAGMA user_version = 1;`

fs.mkdirSync(dirname(path), { recursive: true })
fs.mkdirSync(contextDir, { recursive: true })
// The requested short U1 fixture deliberately fails the production ID pattern;
// successful membership cases below use U00001 (and DDM001 rather than DDM1).
context('U1')
const seed = new DatabaseSync(path)
seed.exec(DDL)
const rows = [
  ['CSESSION', '1.1', 'needle filler padding words for ranking', '', 'inbound', 0],
  ['CSESSION', '1.2', 'needle needle', 'a.pdf\nb.png', 'history', 0],
  ['CSESSION', '1.3', 'needle deleted private', '', 'history', 1],
  ['CSESSION', '1.4', 'Příliš žluťoučký kůň', '', 'inbound', 0],
  ['CSESSION', '1.5', 'foo quoted near x', '', 'outbound', 0],
  ['CSESSION', '1.6', 'bar y', '', 'inbound', 0],
  ['COTHER', '2.1', 'needle other secret', '', 'history', 0],
  ['DDM001', '3.1', 'needle dm secret', '', 'history', 0],
]
for (const [channel, ts, text, attachments, source, deleted] of rows) {
  seed.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(channel, ts, ts, 'U00001', 'x', text, attachments, source, '2026-01-01', '2026-01-02', deleted)
}
seed.close()
const initialHash = digest()
const seededTexts = rows.map(row => row[2])

try {
  Object.assign(process.env, {
    PERSISTENT_STORAGE_PATH: root, TEAMVIBE_CHANNEL_ID: 'TC1', SLACK_CHANNEL: 'CSESSION',
    POLLER_BRAIN_PATH: join(root, 'brain'), INBOX_THREAD_ID: 'B1:CSESSION:1.1', SLACK_BOT_TOKEN: 'xoxb-test',
  })
  delete process.env.TEAMVIBE_API_URL
  delete process.env.TEAMVIBE_POLLER_TOKEN
  const capture = (...args) => {
    const line = args.map(String).join(' ')
    // Node can emit its SQLite warning through console.error or stderr.write.
    if (!/^(\(node:|ExperimentalWarning)/.test(line)) logs.push(line)
  }
  process.stdout.write = (chunk, ...args) => { capture(chunk); const cb = args.find(x => typeof x === 'function'); cb?.(); return true }
  process.stderr.write = (chunk, ...args) => {
    if (!/^(\(node:|ExperimentalWarning)/.test(String(chunk))) capture(chunk)
    const cb = args.find(x => typeof x === 'function'); cb?.(); return true
  }
  for (const key of Object.keys(originalConsole)) console[key] = capture
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url)
    const params = { ...Object.fromEntries(parsed.searchParams), ...Object.fromEntries(new URLSearchParams(options?.body)) }
    const call = { method: parsed.pathname.split('/').at(-1), params, options }
    calls.push(call)
    return reply(call)
  }

  let serverPath = join(mcpDir, 'teamvibe-api.mjs')
  if (baseline) {
    serverPath = join(root, 'baseline-server.mjs')
    fs.writeFileSync(serverPath, execFileSync('git', ['show', '32dcbf2:mcp/teamvibe-api.mjs'], { cwd: mcpDir, stdio: ['ignore', 'pipe', 'pipe'] }))
  }
  const prelude = fs.readFileSync(serverPath, 'utf8').split('// --- stdio transport ---')[0]
    .replaceAll("'./lib/validate-args.mjs'", JSON.stringify(pathToFileURL(join(mcpDir, 'lib', 'validate-args.mjs')).href))
    .replaceAll("'./lib/history-search.mjs'", JSON.stringify(pathToFileURL(join(mcpDir, 'lib', 'history-search.mjs')).href))
  const { handleRequest } = await import('data:text/javascript,' + encodeURIComponent(prelude + '\nexport { handleRequest }\n'))
  // Do not use the head implementation's helper seams when proving baseline red.
  if (!baseline && fs.existsSync(join(mcpDir, 'lib', 'history-search.mjs'))) {
    module = await import(pathToFileURL(join(mcpDir, 'lib', 'history-search.mjs')))
  }
  const request = async (name, args) => JSON.parse(await handleRequest({ id: ++sequence, method: 'tools/call', params: { name, arguments: args } }))
  const search = async (args = { query: 'needle' }) => JSON.parse((await request('search_history', args)).result.content[0].text)
  const reader = (args = {}, deps) => {
    assert.ok(module, 'reader module exists')
    return module.searchHistory({ storagePath: root, channelId: 'TC1', slackChannel: 'CSESSION', query: 'needle', ...args }, deps)
  }
  const deny = (result, code) => {
    check(JSON.stringify(result) === JSON.stringify({ ok: false, error: code }), 'fixed error only, with zero rows')
  }

  await test('tool schema', async () => {
    const tools = JSON.parse(await handleRequest({ id: 1, method: 'tools/list' })).result.tools
    const schema = tools.find(t => t.name === 'search_history')?.inputSchema
    check(!!schema, 'tool is listed')
    check(schema.additionalProperties === false, 'unknown properties forbidden')
    check(JSON.stringify(schema.required) === '["query"]', 'only query required')
    check(schema.properties.query.minLength === 1 && schema.properties.query.maxLength === 500, 'query bounds')
    check(schema.properties.channel.pattern === '^[CDG][A-Z0-9]{5,}$', 'channel pattern')
    check(schema.properties.limit.type === 'integer', 'integer limit')
  })
  for (const [args, expected] of [
    [{ query: 'needle', extra: 1 }, 'Unknown parameter `extra` for search_history. Allowed parameters: query, channel, limit.'],
    [{ query: 3 }, 'Invalid type for parameter `query` for search_history: expected string, got number'],
    [{}, 'Missing required parameter `query` for search_history'],
    [{ query: 'needle', limit: 1.5 }, 'Invalid type for parameter `limit` for search_history: expected integer, got number'],
    [{ query: '' }, 'Invalid value for parameter `query` for search_history: minimum length 1'],
    [{ query: 'x'.repeat(501) }, 'Invalid value for parameter `query` for search_history: maximum length 500'],
    [{ query: 'needle', channel: 'DDM1' }, 'Invalid value for parameter `channel` for search_history: pattern mismatch'],
  ]) await test(`validation ${expected.split(' for ')[0]}`, async () => {
    reset()
    const response = await request('search_history', args)
    check(response.result.isError === true && !response.error, 'MCP tool error')
    deny(JSON.parse(response.result.content[0].text), expected)
    check(calls.length === 0, 'validation does not fetch')
  })

  await test('own channel ranking, isolation, result shape and defaults without API configuration', async () => {
    reset()
    context('system')
    delete process.env.SLACK_BOT_TOKEN
    delete process.env.INBOX_THREAD_ID
    const result = await search()
    check(result.ok === true && result.channel === 'CSESSION', 'own channel succeeds')
    check(result.limit === 20 && result.count === 2, 'default and deleted/channel filters')
    check(result.results.map(r => r.ts).join(',') === '1.2,1.1', 'bm25 ranks repeated term first')
    check(JSON.stringify(result.results[0].attachment_names) === '["a.pdf","b.png"]', 'attachment list')
    check(JSON.stringify(result.results[1].attachment_names) === '[]', 'empty attachment list')
    check(Object.keys(result).sort().join(',') === 'channel,count,limit,ok,results', 'only contracted envelope fields')
    check(Object.keys(result.results[0]).sort().join(',') === 'attachment_names,author,source,text,thread_ts,ts,updated_at,user_id', 'only contracted row fields')
    check(calls.length === 0, 'own channel skips all Slack calls')
    const outbound = await search({ query: 'quoted' })
    check(outbound.results[0].source === 'outbound', 'outbound rows searchable')
    check(calls.length === 0, 'all own-channel calls skip Slack')
  })
  for (const [limit, expected, count] of [[0, 1, 1], [500, 100, 2], [-10, 1, 1]]) {
    await test(`clamp limit ${limit}`, async () => {
      const result = await search({ query: 'needle', limit })
      check(result.limit === expected && result.count === count, 'limit clamped')
    })
  }
  for (const query of ['prilis', 'Příliš']) await test('Czech normalization and diacritics', async () => {
    const result = await search({ query })
    check(result.ok && result.count === 1 && result.results[0].ts === '1.4', 'Czech row matches')
  })
  for (const [query, expected] of [
    ['foo OR bar', ['1.5', '1.6']], ['"quoted"', ['1.5']], ['near(x,y)', ['1.5', '1.6']],
    ['*', []], ['-', []], [':', []],
  ]) await test('FTS syntax becomes plain tokens', async () => {
    const result = await search({ query })
    check(result.ok === true, 'query succeeds')
    check(result.results.map(r => r.ts).sort().join(',') === expected.join(','), 'literal token matches')
    if (!expected.length) check(result.note === 'empty_query', 'punctuation is empty query')
  })
  await test('empty query never loads SQLite', async () => {
    let loads = 0
    const result = reader({ query: '* - :' }, { loadSqlite: () => { loads++; throw new Error('must not open') } })
    check(result.ok && result.note === 'empty_query' && result.count === 0, 'empty result')
    check(loads === 0, 'no loader/open/SQL')
  })
  await test('missing history never loads SQLite, including unconfigured storage', async () => {
    let loads = 0
    const deps = { loadSqlite: () => { loads++; throw new Error('must not load') } }
    for (const args of [{ channelId: 'MISSING' }, { storagePath: undefined }, { channelId: undefined }]) {
      const result = reader(args, deps)
      check(result.ok && result.note === 'no_history' && result.results.length === 0, 'successful empty result')
    }
    check(loads === 0, 'no SQLite for absent history')
  })
  await test('missing channel', async () => {
    reset()
    delete process.env.SLACK_CHANNEL
    deny(await search(), 'no_channel')
    check(calls.length === 0, 'no calls without channel')
  })
  await test('missing file never creates file or directory', async () => {
    reset()
    const before = fs.readdirSync(dirname(path)).join(',')
    process.env.TEAMVIBE_CHANNEL_ID = 'MISSING'
    try {
      const result = await search()
      check(result.ok && result.note === 'no_history' && result.count === 0, 'no history result')
      check(fs.readdirSync(dirname(path)).join(',') === before, 'listing unchanged')
      check(!fs.existsSync(join(root, 'history', 'MISSING.sqlite')), 'no missing file created')
    } finally { process.env.TEAMVIBE_CHANNEL_ID = 'TC1' }
  })
  for (const [name, ddl] of [
    ['version', DDL + '\nPRAGMA user_version = 2;'],
    ['tables', 'CREATE TABLE messages(text); PRAGMA user_version = 1;'],
    ['no-messages', 'CREATE VIRTUAL TABLE history USING fts5(text); PRAGMA user_version = 1;'],
  ]) {
    await test(`invalid index ${name}`, async () => {
      const db = new DatabaseSync(join(root, 'history', `${name}.sqlite`))
      db.exec(ddl); db.close()
      process.env.TEAMVIBE_CHANNEL_ID = name
      try { deny(await search(), 'index_unavailable') } finally { process.env.TEAMVIBE_CHANNEL_ID = 'TC1' }
    })
  }
  await test('constructor/loader exceptions never leak', async () => {
    const message = 'private secret SELECT xoxb-test needle'
    for (const loadSqlite of [() => class { constructor() { throw new Error(message) } }, () => { throw new Error(message) }]) {
      const result = reader({}, { loadSqlite })
      deny(result, 'index_unavailable')
      check(!/private|secret|SELECT|xoxb|needle/.test(JSON.stringify(result)), 'no diagnostics')
    }
  })
  await test('reader binds SQL, opens read-only, checks schema, and always closes', async () => {
    let options, bound, closed = 0
    const statements = []
    const loadSqlite = () => class {
      constructor(_path, opts) { options = opts }
      exec(sql) { statements.push(sql) }
      prepare(sql) {
        statements.push(sql)
        return { get: () => ({ user_version: 1 }), all: (...args) => { bound = args; return [] } }
      }
      close() { closed++ }
    }
    const result = reader({ query: '"needle" OR bar', limit: 500 }, { loadSqlite })
    check(result.ok && options.readOnly === true, 'readOnly option')
    check(JSON.stringify(bound) === JSON.stringify(['"needle" OR "OR" OR "bar"', 'CSESSION', 100]), 'bound token expression/channel/limit')
    check(statements.filter(s => /^PRAGMA/.test(s)).join(';') === 'PRAGMA busy_timeout = 2000;PRAGMA user_version', 'only contracted pragmas')
    check(!statements.some(s => /CREATE|INSERT|UPDATE|DELETE|journal_mode/.test(s)), 'no writes or DDL')
    check(closed === 1, 'handle closed')
    for (const message of ['no such module: fts5', 'private SQL failure']) {
      let closed = 0
      const result = reader({}, { loadSqlite: () => class {
        exec() { throw new Error(message) }
        close() { closed++ }
      } })
      deny(result, 'index_unavailable')
      check(closed === 1, 'close on exception')
    }
  })

  await test('cross-channel paginated membership and positive cache', async () => {
    reset()
    reply = async ({ method, params }) => ({ ok: true, json: async () => method === 'conversations.info'
      ? { ok: true, channel: { is_member: true } }
      : params.cursor === 'c1' ? { ok: true, members: ['U00001'] }
        : { ok: true, members: ['U00009', 'U00008'], response_metadata: { next_cursor: 'c1' } } })
    const result = await search({ query: 'needle', channel: 'COTHER' })
    check(result.ok && result.results[0].ts === '2.1' && result.count === 1, 'only other-channel row')
    check(calls.map(c => c.method).join(',') === 'conversations.info,conversations.members,conversations.members', 'one info, two member pages')
    check(calls[1].params.limit === '200' && calls[2].params.cursor === 'c1', 'limit and cursor passed')
    check(calls.every(c => c.params.channel === 'COTHER' && c.options.headers.Authorization === 'Bearer xoxb-test'), 'bot authentication and channel')
    check((await search({ query: 'needle', channel: 'COTHER' })).ok, 'second search succeeds')
    check(calls.length === 3, 'positive cache avoids further fetches')
    context('W00002')
    reply = async ({ method }) => ({ ok: true, json: async () => method === 'conversations.info'
      ? { ok: true, channel: { is_member: true } } : { ok: true, members: ['W00002'] } })
    check((await search({ query: 'needle', channel: 'COTHER' })).ok && calls.length === 5, 'cache separates requesters')
    check((await search({ query: 'needle', channel: 'DDM001' })).ok && calls.length === 7, 'cache separates channels')
  })
  await test('negative membership is not cached', async () => {
    reset()
    reply = async ({ method }) => ({ ok: true, json: async () => method === 'conversations.info'
      ? { ok: true, channel: { is_member: true } } : { ok: true, members: ['U00009'] } })
    deny(await search({ query: 'needle', channel: 'COTHER' }), 'not_a_member')
    check(calls.length === 2, 'first verification complete')
    deny(await search({ query: 'needle', channel: 'COTHER' }), 'not_a_member')
    check(calls.length === 4, 'negative verdict re-queries')
  })
  for (const [label, response] of [
    ['not found', { ok: false, error: 'channel_not_found' }], ['not a bot member', { ok: true, channel: { is_member: false } }],
    ['missing fields', { ok: true }], ['nonboolean', { ok: true, channel: { is_member: 'true' } }],
  ]) await test(`bot access denied: ${label}`, async () => {
    reset()
    reply = async () => ({ ok: true, json: async () => response })
    deny(await search({ query: 'needle', channel: 'COTHER' }), 'channel_not_accessible')
    check(calls.length === 1 && calls[0].method === 'conversations.info', 'no members call')
  })
  for (const failure of ['throw', 'http', 'json', 'ok', 'missing']) {
    for (const stage of ['info', 'members']) await test(`Slack ${stage} failure: ${failure}`, async () => {
      reset()
      reply = async ({ method }) => {
        if (method === 'conversations.info' && stage === 'members') return { ok: true, json: async () => ({ ok: true, channel: { is_member: true } }) }
        if (failure === 'throw') throw new Error('private Slack xoxb-test needle')
        return { ok: failure !== 'http', json: async () => {
          if (failure === 'json') throw new Error('private JSON')
          return failure === 'missing' ? { ok: true } : { ok: false, error: 'private Slack diagnostic' }
        } }
      }
      deny(await search({ query: 'needle', channel: 'COTHER' }), stage === 'info' ? 'channel_not_accessible' : 'membership_unverified')
    })
  }
  for (const kind of ['is_im', 'is_mpim']) await test(`DM access with ${kind}`, async () => {
    reset()
    reply = async ({ method }) => ({ ok: true, json: async () => method === 'conversations.info'
      ? { ok: true, channel: { [kind]: true } } : { ok: true, members: ['U00001', 'B1'] } })
    const result = await search({ query: 'needle', channel: 'DDM001' })
    check(result.ok && result.results[0].ts === '3.1' && result.count === 1, 'DM membership verified')
    check(calls.length === 2, 'DM requires info and members')
  })
  for (const id of ['system', 'U1', '', 'B00001', null]) await test('invalid requester fails closed', async () => {
    reset(); context(id)
    deny(await search({ query: 'needle', channel: 'COTHER' }), 'requester_unresolved')
    check(!calls.some(c => c.method === 'conversations.members'), 'no members call')
  })
  for (const kind of ['missing file', 'unparseable', 'missing env', 'missing sender']) await test(`unresolved requester: ${kind}`, async () => {
    reset()
    if (kind === 'missing file') fs.unlinkSync(contextPath)
    if (kind === 'unparseable') fs.writeFileSync(contextPath, '{')
    if (kind === 'missing env') delete process.env.INBOX_THREAD_ID
    if (kind === 'missing sender') fs.writeFileSync(contextPath, '{}')
    deny(await search({ query: 'needle', channel: 'COTHER' }), 'requester_unresolved')
  })
  await test('missing bot token', async () => {
    reset(); delete process.env.SLACK_BOT_TOKEN
    deny(await search({ query: 'needle', channel: 'COTHER' }), 'channel_not_accessible')
    check(calls.length === 0, 'no unauthenticated fetch')
  })
  await test('membership page cap fails closed', async () => {
    reset()
    reply = async ({ method }) => ({ ok: true, json: async () => method === 'conversations.info'
      ? { ok: true, channel: { is_member: true } } : { ok: true, members: [], response_metadata: { next_cursor: 'loop' } } })
    deny(await search({ query: 'needle', channel: 'COTHER' }), 'membership_unverified')
    check(calls.length === 21, 'one info plus maximum 20 pages')
  })
  await test('guard dependency injection and no filesystem access for own channel', async () => {
    assert.ok(module, 'guard module exists')
    let reads = 0, fetches = 0
    const result = await module.guardHistoryChannel({ channel: 'CSESSION', sessionChannel: 'CSESSION' }, {
      fs: { readFileSync() { reads++; throw new Error('private') } },
      fetch: async () => { fetches++; throw new Error('private') }, cache: new Map(),
    })
    check(result.ok && reads === 0 && fetches === 0, 'own channel needs no requester/token/network')
  })
  await test('guard injected filesystem, fetch and cache preserve literal thread ID', async () => {
    assert.ok(module, 'guard module exists')
    const cache = new Map(), paths = [], methods = []
    const result = await module.guardHistoryChannel({
      channel: 'COTHER', sessionChannel: 'CSESSION', token: 'xoxb-test', threadId: 'B1:CSESSION:1.1',
    }, {
      cache,
      fs: { readFileSync(path) { paths.push(path); return JSON.stringify({ sender: { id: 'W00002' } }) } },
      fetch: async url => {
        methods.push(url)
        return { ok: true, json: async () => url.endsWith('conversations.info')
          ? { ok: true, channel: { is_member: true } } : { ok: true, members: ['W00002'] } }
      },
    })
    check(result.ok && methods.length === 2, 'injected Slack calls verify W requester')
    check(paths[0] === join(process.cwd(), '.inbox', 'B1:CSESSION:1.1', 'context.json'), 'cwd fallback and literal colons')
    check(cache.get(JSON.stringify(['COTHER', 'W00002'])) === true, 'positive verdict in injected cache')
  })
  await test('guard blocks before SQLite is loaded or opened', async () => {
    reset()
    // With a corrupt index, each denied request must still return only its guard code.
    process.env.TEAMVIBE_CHANNEL_ID = 'tables'
    reply = async () => ({ ok: true, json: async () => ({ ok: false }) })
    try { deny(await search({ query: 'needle', channel: 'COTHER' }), 'channel_not_accessible') }
    finally { process.env.TEAMVIBE_CHANNEL_ID = 'TC1' }
  })

  async function withLock(mode, ms, fn) {
    const child = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN ${mode}');
      process.stdout.write('ready\\n');
      setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, Number(process.argv[2]));
    `, path, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const ended = once(child, 'exit')
    try {
      await Promise.race([once(child.stdout, 'data'), ended.then(() => { throw new Error('lock child exited early') })])
      await fn()
    } finally {
      child.kill()
      await ended
    }
  }
  for (const ms of [300, 2500]) await test(`BEGIN IMMEDIATE allows reads (${ms} ms writer)`, async () => {
    reset()
    await withLock('IMMEDIATE', ms, async () => {
      const result = await search()
      check(result.ok && result.count === 2, 'reserved lock permits reader')
    })
  })
  await test('short exclusive writer contention is tolerated', async () => {
    reset()
    await withLock('EXCLUSIVE', 300, async () => {
      const started = Date.now(), result = await search()
      check(result.ok && result.count === 2, 'returns rows after writer releases')
      check(Date.now() - started >= 150, 'reader waited for lock')
    })
  })
  await test('long exclusive writer contention times out safely', async () => {
    reset()
    await withLock('EXCLUSIVE', 2500, async () => {
      const started = Date.now()
      deny(await search(), 'index_unavailable')
      const elapsed = Date.now() - started
      check(elapsed >= 1800 && elapsed < 4000, 'bounded busy timeout')
    })
  })
  await test('all searches leave sqlite bytes and side files unchanged', async () => {
    check(digest() === initialHash, 'SHA-256 unchanged')
    check(sideFiles().length === 0, 'no WAL/journal/SHM created')
  })
  await test('no application stdout/stderr/console logs or private diagnostics', async () => {
    const privatePattern = /needle|prilis|SELECT|xoxb/i
    check(!logs.some(line => privatePattern.test(line) || seededTexts.some(text => line.includes(text))), 'no private logs')
    check(logs.length === 0, 'no application logging at all')
  })
} finally {
  globalThis.fetch = realFetch
  process.stdout.write = originalStdout
  process.stderr.write = originalStderr
  Object.assign(console, originalConsole)
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  fs.rmSync(root, { recursive: true, force: true })
}
output(`\n${pass} passed, ${fail} failed${baseline ? ' (baseline 32dcbf2)' : ''}\n`)
if (fail) process.exitCode = 1
