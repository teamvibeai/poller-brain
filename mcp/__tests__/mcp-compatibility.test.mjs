// Run: node --test mcp/__tests__/mcp-compatibility.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as slack from '../lib/slack-tools.mjs'
import * as api from '../lib/teamvibe-api-tools.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
// Catalog v1 API names are explicit; Slack alone uses a mechanical prefix.
const apiNames = {
  create_scheduled_message: 'schedule_create',
  list_scheduled_messages: 'schedule_list',
  delete_scheduled_message: 'schedule_delete',
  submit_feedback: 'feedback_submit',
}
const pairs = [
  ...slack.TOOLS.map(({ name }) => [`mcp__slack__${name}`, `mcp__teamvibe__slack_${name}`]),
  ...api.TOOLS.map(({ name }) => [`mcp__teamvibe-api__${name}`, `mcp__teamvibe__${apiNames[name]}`]),
]
const names = pairs.flat()
const serverRules = ['mcp__teamvibe__*', 'mcp__slack__*', 'mcp__teamvibe-api__*']
const covers = (rule, name) => rule === name || (serverRules.includes(rule) && name.startsWith(rule.slice(0, -1)))

function assertParity(rules, label) {
  for (const rule of rules) {
    assert.ok(names.includes(rule) || serverRules.includes(rule), `${label}: unknown name or unsupported partial glob ${rule}`)
  }
  for (const [legacy, merged] of pairs) {
    assert.equal(rules.some(rule => covers(rule, merged)), rules.some(rule => covers(rule, legacy)),
      `${label}: ${legacy} and ${merged} must both be covered`)
  }
}

function assertPermissionParity(config) {
  for (const kind of ['allow', 'deny', 'ask']) {
    assertParity((config.permissions?.[kind] ?? []).filter(rule => rule.startsWith('mcp__')), `permissions.${kind}`)
  }
}

function assertHookParity(config) {
  for (const [event, groups] of Object.entries(config.hooks)) {
    for (const group of groups) {
      if (!group.matcher) continue
      const matcher = new RegExp(group.matcher)
      for (const [legacy, merged] of pairs) {
        assert.equal(matcher.test(merged), matcher.test(legacy), `${event}: ${legacy} and ${merged} must share hooks`)
      }
    }
  }
}

test('capability declares catalog, shared handlers and instructions v1 together', () => {
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'mcp/capabilities.json'), 'utf8')), {
    version: 1, teamvibe: { entrypoint: 'teamvibe.mjs', catalogVersion: 1, sharedHandlersVersion: 1, instructionsVersion: 1 },
  })
  assert.equal(slack.TOOLS.length, 23)
  assert.deepEqual(api.TOOLS.map(tool => tool.name).sort(), Object.keys(apiNames).sort())
  assert.equal(new Set(names).size, 54)
  const instructions = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
  for (const [legacy, merged] of pairs.slice(23)) {
    assert.ok(instructions.includes(legacy) && instructions.includes(merged), `${legacy} mapping must be documented`)
  }
  assert.ok(instructions.includes('mcp__teamvibe__slack_<name>') && instructions.includes('mcp__slack__<name>'))
})

test('all MCP references in settings and hook scripts have counterparts in both directions', () => {
  const files = ['settings.json', ...readdirSync(join(root, 'hooks'), { recursive: true })
    .filter(name => name.endsWith('.sh')).map(name => join('hooks', name))]
  for (const file of files) {
    const references = readFileSync(join(root, file), 'utf8').match(/mcp__(?:slack|teamvibe-api|teamvibe)__[\w*]+/g) ?? []
    assertParity(references, file)
  }
  assertPermissionParity(settings)
  assertHookParity(settings)
  for (const name of names) assert.ok(settings.permissions.allow.some(rule => covers(rule, name)), `${name} must be allowed`)
})

test('parity checks reject a missing permission, hook counterpart, or partial tool glob', () => {
  for (const rule of serverRules) {
    const config = structuredClone(settings)
    config.permissions.allow = config.permissions.allow.filter(value => value !== rule)
    assert.throws(() => assertPermissionParity(config), /must both be covered/)
  }
  for (const name of ['mcp__slack__send_message', 'mcp__teamvibe__slack_send_message']) {
    const config = structuredClone(settings)
    config.hooks.PreToolUse.find(group => group.matcher.includes('send_message')).matcher = `^${name}$`
    assert.throws(() => assertHookParity(config), /must share hooks/)
  }
  assert.throws(() => assertParity(['mcp__teamvibe__slack_*'], 'partial glob'), /unsupported partial glob/)
  assert.throws(() => assertParity(['mcp__teamvibe__schedule_missing'], 'unknown tool'), /unknown name/)
})

test('only the two exact send names invoke the bold hook, which blocks both modes', () => {
  const sendNames = ['mcp__teamvibe__slack_send_message', 'mcp__slack__send_message']
  const group = settings.hooks.PreToolUse.find(group => new RegExp(group.matcher).test(sendNames[0]))
  assert.ok(group)
  const matcher = new RegExp(group.matcher)
  for (const name of [...names.filter(name => !sendNames.includes(name)),
    'mcp__other__slack_send_message', 'mcp__teamvibe__slack_send_message_extra', 'prefix_mcp__slack__send_message']) {
    assert.equal(matcher.test(name), false, name)
  }
  for (const name of sendNames) {
    assert.ok(matcher.test(name))
    for (const [text, denied] of [['**wrong bold**', true], ['*correct bold*', false], ['`**code**`', false]]) {
      for (const hook of group.hooks) {
        const result = spawnSync('sh', ['-c', hook.command], {
          input: JSON.stringify({ tool_name: name, tool_input: { text } }), encoding: 'utf8',
          env: { ...process.env, CLAUDE_CONFIG_DIR: root }, timeout: 5000,
        })
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.error, undefined)
        if (denied) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
        else assert.equal(result.stdout, '')
      }
    }
  }
})

test('shared handler imports need no credentials, transport, stdout or exit', () => {
  const script = `
    import assert from 'node:assert/strict';
    const before = process.stdin.eventNames().map(name => [name, process.stdin.listenerCount(name)]);
    process.stdout.write = () => { throw new Error('shared import wrote to stdout') };
    process.exit = () => { throw new Error('shared import exited') };
    for (const domain of ['slack', 'teamvibe-api']) {
      const registry = await import('./mcp/lib/' + domain + '-tools.mjs');
      assert.ok(Array.isArray(registry.TOOLS));
      assert.equal(typeof registry.handleRequest, 'function');
    }
    assert.deepEqual(process.stdin.eventNames().map(name => [name, process.stdin.listenerCount(name)]), before);
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

for (const [domain, registry] of [['slack', slack], ['teamvibe-api', api]]) {
  test(`legacy ${domain} stdio keeps its identity, catalog and validation behavior`, async () => {
    const requests = [
      { id: 1, method: 'initialize' }, { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      ...registry.TOOLS.map((tool, index) => ({ id: index + 3, method: 'tools/call', params: {
        name: tool.name, arguments: { unknown_parameter: true },
      } })),
      { id: 'unknown', method: 'not/a/method' },
    ]
    const result = spawnSync(process.execPath, [join(root, 'mcp', `${domain}.mjs`)], {
      input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
      env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(responses.find(response => response.id === 1).result.serverInfo.name, domain)
    for (const request of requests) {
      const expected = await registry.handleRequest(request)
      if (expected === null) continue
      assert.deepEqual(responses.find(response => response.id === request.id), JSON.parse(expected))
    }
    assert.equal(responses.length, requests.length - 1)
  })
}

test('declared merged entrypoint lists catalog v1 and dispatches both real handler modules over stdio', async t => {
  // Keep this independent of the production renaming map and shared catalogs:
  // removing or renaming any published tool must fail this contract.
  const expectedNames = [
    'slack_send_message', 'slack_add_reaction', 'slack_remove_reaction', 'slack_list_reactions',
    'slack_read_thread', 'slack_read_channel', 'slack_get_permalink', 'slack_list_thread_participants',
    'slack_read_channel_info', 'slack_set_channel_topic', 'slack_set_channel_purpose', 'slack_list_pins',
    'slack_pin_message', 'slack_unpin_message', 'slack_list_bookmarks', 'slack_upload_snippet',
    'slack_download_file', 'slack_upload_file', 'slack_update_message', 'slack_set_status',
    'slack_list_channels', 'slack_search_users', 'slack_set_expected_duration',
    'schedule_create', 'schedule_list', 'schedule_delete', 'feedback_submit',
  ]
  const feedback = { type: 'bug', priority: 'low', context: 'Merged stdio dispatch test' }
  const requests = [
    { id: 1, method: 'initialize' }, { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'slack_send_message', arguments: { text: 'Merged test', thread_ts: null } } },
    { id: 4, method: 'tools/call', params: { name: 'schedule_list', arguments: {} } },
    { id: 5, method: 'tools/call', params: { name: 'feedback_submit', arguments: feedback } },
  ]
  const capability = JSON.parse(readFileSync(join(root, 'mcp/capabilities.json'), 'utf8')).teamvibe
  const child = spawnSync(process.execPath, [
    '--import', fileURLToPath(new URL('./fixtures/merged-api-mock.mjs', import.meta.url)),
    join(root, 'mcp', capability.entrypoint),
  ], {
    input: requests.map(request => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n') + '\n',
    env: {
      PATH: process.env.PATH, SLACK_BOT_TOKEN: 'slack-test', SLACK_CHANNEL: 'C_TEST',
      TEAMVIBE_API_URL: 'https://api.invalid', TEAMVIBE_POLLER_TOKEN: 'api-test',
      TEAMVIBE_WORKSPACE_ID: 'W_TEST', TEAMVIBE_CHANNEL_ID: 'TC_TEST',
    },
    encoding: 'utf8', timeout: 5000,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  const responses = child.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(responses.map(response => response.id).sort(), [1, 2, 3, 4, 5])
  const response = id => responses.find(response => response.id === id)
  const result = id => {
    assert.equal(response(id).result.isError, undefined, JSON.stringify(response(id)))
    return JSON.parse(response(id).result.content[0].text)
  }
  await t.test('initialize and all 27 merged names', () => {
    assert.deepEqual(response(1).result, {
      protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'teamvibe', version: '1.0.0' },
    })
    assert.deepEqual(response(2).result.tools.map(tool => tool.name).sort(), expectedNames.sort())
  })
  await t.test('Slack handler reaches chat.postMessage', () => {
    assert.equal(result(3).ok, true)
    assert.equal(result(3).ts, '1234.567890')
  })
  await t.test('API handler reaches scheduled-messages', () => {
    assert.deepEqual(result(4), { items: [], marker: 'schedule-dispatched' })
  })
  await t.test('API handler reaches feedback', () => {
    assert.deepEqual(result(5), { ok: true, marker: 'feedback-dispatched' })
  })
  // The preload records actual fetches; no handler or routing implementation is mocked.
  const calls = child.stderr.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls, [
    { url: 'https://slack.com/api/chat.postMessage', method: 'POST', authorization: 'Bearer slack-test',
      body: { channel: 'C_TEST', text: 'Merged test', unfurl_links: false, unfurl_media: false } },
    { url: 'https://api.invalid/scheduled-messages?workspaceId=W_TEST&channelId=TC_TEST', method: 'GET', authorization: 'Bearer api-test' },
    { url: 'https://api.invalid/feedback', method: 'POST', authorization: 'Bearer api-test', body: { channelId: 'TC_TEST', ...feedback } },
  ])
})
