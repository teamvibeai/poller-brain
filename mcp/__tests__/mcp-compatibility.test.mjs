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
    version: 1, teamvibe: { catalogVersion: 1, sharedHandlersVersion: 1, instructionsVersion: 1 },
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
