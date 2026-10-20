// Shared shallow argument validation — no server, network, or dependencies.
// Run: node mcp/__tests__/validate-args.test.mjs
let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

let validateArgs
try {
  ;({ validateArgs } = await import('../lib/validate-args.mjs'))
} catch (e) {
  console.log(`  ${e.code}: shared validator is unavailable`)
}
ok('shared validator exports validateArgs', typeof validateArgs === 'function')

if (validateArgs) {
  const schema = {
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
  }
  const validate = (args) => validateArgs('send_message', args, schema)
  const incidentError = 'Unknown parameter `channel_id` for send_message. Allowed parameters: text, blocks, channel, thread_ts, modals. Did you mean `channel`?'
  ok('#553 names unknown key, tool, allowed keys, and channel suggestion',
    validate({ channel_id: 'C0CA0CBLA7R', text: 'x' }) === incidentError)
  ok('camelCase suggests thread_ts',
    validate({ text: 'x', threadTs: '1.1' })?.endsWith('Did you mean `thread_ts`?'))
  ok('small edit distance suggests channel',
    validate({ text: 'x', chanel: 'C1' })?.endsWith('Did you mean `channel`?'))
  ok('case variant suggests scheduleId',
    validateArgs('delete_scheduled_message', { scheduleID: 's1' }, {
      type: 'object', properties: { scheduleId: { type: 'string' } }, required: ['scheduleId'],
    })?.endsWith('Did you mean `scheduleId`?'))
  ok('unrelated key has no suggestion',
    validate({ text: 'x', completely_unrelated: true }) ===
      'Unknown parameter `completely_unrelated` for send_message. Allowed parameters: text, blocks, channel, thread_ts, modals.')
  ok('prototype key is unknown', validate(JSON.parse('{"text":"x","__proto__":{}}'))?.includes('Unknown parameter `__proto__`'))
  ok('missing required text', validate({}) === 'Missing required parameter `text` for send_message')
  ok('inherited value does not satisfy required',
    validate(Object.create({ text: 'inherited' })) === 'Missing required parameter `text` for send_message')
  ok('string is not coerced from number', validate({ text: 1 }) ===
    'Invalid type for parameter `text` for send_message: expected string, got number')
  ok('null union accepts null', validate({ text: 'x', thread_ts: null }) === null)
  ok('null union accepts string', validate({ text: 'x', thread_ts: '1.1' }) === null)
  ok('null union rejects boolean', validate({ text: 'x', thread_ts: false }) ===
    'Invalid type for parameter `thread_ts` for send_message: expected string or null, got boolean')
  ok('null without declared union is rejected', validate({ text: null })?.includes('expected string, got null'))
  ok('array is distinct from object', validate({ text: 'x', blocks: {} })?.includes('expected array, got object'))
  ok('array item must be object', validate({ text: 'x', blocks: [null] })?.includes('`blocks[0]`'))
  ok('required modal view is checked before any handler can send', validate({ text: 'x', modals: [{ label: 'Open' }] }) ===
    'Missing required parameter `modals[0].view` for send_message')
  ok('modal view must be object', validate({ text: 'x', modals: [{ view: [] }] })?.includes('expected object, got array'))
  ok('modal label type is checked one level down',
    validate({ text: 'x', modals: [{ view: {}, label: 1 }] })?.includes('`modals[0].label`'))
  ok('modal contents and Block Kit fields stay loose', validate({
    text: 'x', blocks: [{ anything: { deeply: ['loose'] } }],
    modals: [{ view: { blocks: 'not validated here' }, extra: 'allowed inside modal' }],
  }) === null)
  const primitiveSchema = {
    type: 'object',
    properties: { count: { type: 'number' }, enabled: { type: 'boolean' }, origin: {
      type: 'object', properties: { channel: { type: 'string' } },
    } },
  }
  for (const [key, value, expected] of [
    ['count', '2', 'number'], ['count', NaN, 'number'], ['count', Infinity, 'number'],
    ['enabled', 'true', 'boolean'], ['origin', [], 'object'], ['origin', null, 'object'],
  ]) {
    ok(`${key} rejects ${String(value)} (${expected})`,
      validateArgs('example', { [key]: value }, primitiveSchema)?.includes(`expected ${expected}`))
  }
  ok('direct object property type checked',
    validateArgs('example', { origin: { channel: 1 } }, primitiveSchema)?.includes('`origin.channel`'))
  ok('number/boolean/object happy path',
    validateArgs('example', { count: 2, enabled: false, origin: { channel: 'C1' } }, primitiveSchema) === null)
  for (const value of [null, false, 0, '', [], 'text']) {
    ok(`arguments must be object (${JSON.stringify(value)})`, validate(value)?.includes('expected object'))
  }
  ok('happy path returns null', validate({ text: 'x', channel: 'C1', blocks: [] }) === null)
  ok('validation leaves arguments untouched', (() => {
    const args = { text: 'x', thread_ts: null, modals: [{ view: { blocks: [] } }] }
    const before = JSON.stringify(args)
    validate(args)
    return JSON.stringify(args) === before
  })())
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
