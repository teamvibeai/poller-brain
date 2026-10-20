// Shared shallow argument validation — no network or server transport.
// Run: node mcp/__tests__/validate-args.test.mjs
import { validateArgs } from '../lib/validate-args.mjs'

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

const tool = {
  name: 'send_message',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      blocks: { type: 'array', items: { type: 'object' } },
      channel: { type: 'string' },
      thread_ts: { type: ['string', 'null'] },
      modals: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, view: { type: 'object' } },
          required: ['view'],
        },
      },
    },
    required: ['text'],
  },
}
const validate = (args) => validateArgs(tool, args)
const incidentError = 'Unknown parameter `channel_id` for send_message. Allowed parameters: text, blocks, channel, thread_ts, modals. Did you mean `channel`?'
ok('#553 names bad key, tool, allowed keys and suggestion', validate({ channel_id: 'C0CA0CBLA7R', text: 'x' }) === incidentError)
ok('small edit distance suggests channel', validate({ text: 'x', chanel: 'C1' })?.includes('Did you mean `channel`?'))
ok('camelCase suggests thread_ts', validate({ text: 'x', threadTs: '1.1' })?.includes('Did you mean `thread_ts`?'))
ok('case variant suggests scheduleId', validateArgs({ name: 'delete_scheduled_message', inputSchema: { properties: { scheduleId: { type: 'string' } } } }, { scheduleID: 'S1' })?.includes('Did you mean `scheduleId`?'))
ok('unrelated key has no suggestion', !validate({ text: 'x', unrelated: true })?.includes('Did you mean'))
for (const key of ['constructor', 'toString', '__proto__']) {
  ok(`inherited property name ${key} is unknown`, validate(JSON.parse(`{"text":"x","${key}":1}`))?.includes(`Unknown parameter \`${key}\``))
}
ok('missing required text', validate({}) === 'Missing required parameter `text` for send_message')
ok('null is present but is not a string', validate({ text: null })?.includes('Invalid type for parameter `text` for send_message: expected string, got null'))
ok('number does not coerce to string', validate({ text: 42 })?.includes('expected string, got number'))
ok('string union member accepted', validate({ text: 'x', thread_ts: '1.1' }) === null)
ok('null union member accepted', validate({ text: 'x', thread_ts: null }) === null)
ok('non-member of union rejected', validate({ text: 'x', thread_ts: false })?.includes('expected string or null, got boolean'))
ok('array required for blocks', validate({ text: 'x', blocks: {} })?.includes('expected array, got object'))
ok('block items must be objects', validate({ text: 'x', blocks: ['bad'] })?.includes('`blocks[0]`'))
ok('null is not an object item', validate({ text: 'x', blocks: [null] })?.includes('expected object, got null'))
ok('modals item required view', validate({ text: 'x', modals: [{ label: 'Open' }] }) === 'Missing required parameter `modals[0].view` for send_message')
ok('checks every modal item', validate({ text: 'x', modals: [{ view: {} }, {}] })?.includes('`modals[1].view`'))
ok('modal view must be an object', validate({ text: 'x', modals: [{ view: [] }] })?.includes('expected object, got array'))
ok('modal label must be a string', validate({ text: 'x', modals: [{ label: 4, view: {} }] })?.includes('`modals[0].label`'))
ok('Block Kit and modal view contents stay loose', validate({ text: '', blocks: [{ arbitrary: { nested: [null] } }], modals: [{ view: { blocks: 'unchecked' }, extra: true }] }) === null)
ok('happy path', validate({ text: 'x', channel: 'C1', blocks: [], modals: [{ view: {} }] }) === null)
for (const value of [null, false, 0, '', [], 'x']) {
  ok(`rejects non-object arguments ${JSON.stringify(value)}`, validate(value)?.includes('Arguments for send_message must be an object'))
}

const scalarTool = {
  name: 'example',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number', minimum: 1 },
      enabled: { type: 'boolean' },
      mode: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
      origin: { type: 'object', properties: { channel: { type: 'string' } } },
    },
  },
}
ok('number and boolean accepted', validateArgs(scalarTool, { count: 1, enabled: false }) === null)
ok('numeric string rejected', validateArgs(scalarTool, { count: '1' })?.includes('expected number, got string'))
ok('boolean string rejected', validateArgs(scalarTool, { enabled: 'false' })?.includes('expected boolean, got string'))
ok('object property rejects arrays', validateArgs(scalarTool, { origin: [] })?.includes('expected object, got array'))
ok('one level of declared object properties checked', validateArgs(scalarTool, { origin: { channel: 1 } })?.includes('`origin.channel`'))
ok('declared enum rejected', validateArgs(scalarTool, { mode: 'BROKEN' })?.includes('`mode`'))
ok('declared enum accepted', validateArgs(scalarTool, { mode: 'ACTIVE' }) === null)
ok('declared minimum rejected', validateArgs(scalarTool, { count: 0 })?.includes('`count`'))
ok('empty optional arguments accepted', validateArgs(scalarTool, {}) === null)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
