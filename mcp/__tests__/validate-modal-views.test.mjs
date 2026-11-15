import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateModalViews } from '../lib/validate-modal-views.mjs'

const text = (value) => ({ type: 'plain_text', text: value })
const option = (value = 'one') => ({ text: text('Option'), value })
const input = (element = { type: 'plain_text_input', action_id: 'answer' }, block_id = 'field') => ({
  type: 'input', block_id, label: text('Field'), element,
})
const view = (fields = {}) => ({ type: 'modal', title: text('Form'), blocks: [], ...fields })
const check = (value, wrapper = {}) => validateModalViews([{ ...wrapper, view: value }])
const invalid = (value, path, rule, wrapper) => {
  assert.equal(check(value, wrapper), `Invalid value for parameter \`modals[0].${path}\` for send_message: ${rule}`)
}

for (const field of ['title', 'submit', 'close']) {
  test(`${field}: exact limit, one over, Unicode characters, shape and type`, () => {
    assert.equal(check(view({ [field]: text('a'.repeat(24)) })), null)
    assert.equal(check(view({ [field]: text('😀'.repeat(24)) })), null)
    invalid(view({ [field]: text('😀'.repeat(25)) }), `view.${field}.text`, 'maximum length 24')
    invalid(view({ [field]: text('a'.repeat(25)) }), `view.${field}.text`, 'maximum length 24')
    invalid(view({ [field]: text('') }), `view.${field}.text`, 'minimum length 1')
    invalid(view({ [field]: { type: 'mrkdwn', text: 'x' } }), `view.${field}.type`, 'must be plain_text')
    invalid(view({ [field]: null }), `view.${field}`, 'must be an object')
    invalid(view({ [field]: { type: 'plain_text', text: 9 } }), `view.${field}.text`, 'must be a string')
  })
}

for (const [field, limit] of [['callback_id', 255], ['private_metadata', 3000]]) {
  test(`${field}: limits and type`, () => {
    assert.equal(check(view({ [field]: 'a'.repeat(limit) })), null)
    invalid(view({ [field]: 'a'.repeat(limit + 1) }), `view.${field}`, `maximum length ${limit}`)
    invalid(view({ [field]: {} }), `view.${field}`, 'must be a string')
  })
}

test('wrapper callbackId is checked even when view has callback_id', () => {
  assert.equal(check(view({ callback_id: 'view' }), { callbackId: 'a'.repeat(255) }), null)
  invalid(view(), 'callbackId', 'must be a string', { callbackId: 12 })
  invalid(view({ callback_id: 'view' }), 'callbackId', 'maximum length 255', { callbackId: 'a'.repeat(256) })
  invalid(view({ callback_id: 'a'.repeat(256) }), 'view.callback_id', 'maximum length 255', { callbackId: 'wrapper' })
})

test('required modal fields and blocks limits', () => {
  invalid(view({ type: 'home' }), 'view.type', 'must be modal')
  const missingTitle = view(); delete missingTitle.title
  invalid(missingTitle, 'view.title', 'must be an object')
  invalid(view({ blocks: null }), 'view.blocks', 'must be an array')
  const missingBlocks = view(); delete missingBlocks.blocks
  invalid(missingBlocks, 'view.blocks', 'must be an array')
  assert.equal(check(view({ blocks: Array.from({ length: 100 }, () => ({ type: 'divider' })) })), null)
  invalid(view({ blocks: Array.from({ length: 101 }, () => ({ type: 'divider' })) }), 'view.blocks', 'maximum items 100')
  invalid(view({ blocks: [null] }), 'view.blocks[0]', 'must be an object')
})

test('input submit, explicit block ID and known element action ID', () => {
  invalid(view({ blocks: [input()] }), 'view.submit', 'required when blocks contain inputs')
  const form = view({ submit: text('Send'), blocks: [input()] })
  assert.equal(check(form), null)
  for (const block_id of [undefined, '', 42]) {
    invalid(view({ submit: text('Send'), blocks: [{ ...input(), block_id }] }), 'view.blocks[0].block_id', 'must be a nonempty string')
  }
  for (const type of ['plain_text_input', 'static_select', 'multi_static_select', 'external_select', 'multi_external_select', 'users_select', 'multi_users_select', 'conversations_select', 'multi_conversations_select', 'channels_select', 'multi_channels_select', 'radio_buttons', 'checkboxes', 'datepicker', 'timepicker', 'datetimepicker', 'number_input', 'email_text_input', 'url_text_input', 'rich_text_input', 'file_input']) {
    invalid(view({ submit: text('Send'), blocks: [input({ type })] }), 'view.blocks[0].element.action_id', 'must be a nonempty string')
  }
})

test('duplicate block IDs across all block types; unrelated blocks need no IDs', () => {
  assert.equal(check(view({ blocks: [{ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: 'x' } }] })), null)
  invalid(view({ blocks: [{ type: 'divider', block_id: 'same' }, { type: 'section', block_id: 'same' }] }), 'view.blocks[1].block_id', 'must be unique within the view')
})

for (const type of ['static_select', 'multi_static_select', 'radio_buttons', 'checkboxes', 'overflow']) {
  test(`${type}: option boundaries and uniqueness scoped to element`, () => {
    const element = { type, action_id: 'choice', options: [option('v'.repeat(150))] }
    const make = () => view({ submit: text('Send'), blocks: [input(element)] })
    element.options[0].text.text = 'L'.repeat(75)
    assert.equal(check(make()), null)
    element.options[0].value += 'v'
    invalid(make(), 'view.blocks[0].element.options[0].value', 'maximum length 150')
    element.options[0].value = 'one'; element.options[0].text.text += 'L'
    invalid(make(), 'view.blocks[0].element.options[0].text.text', 'maximum length 75')
    element.options = [option('one'), option('one')]
    invalid(make(), 'view.blocks[0].element.options[1].value', 'must be unique within the element options')
    element.options = [option('one')]
    element.initial_option = option('one'); element.initial_options = [option('one')]
    const form = make(); form.blocks.push(input(structuredClone(element), 'second'))
    assert.equal(check(form), null)
    assert.equal(validateModalViews([{ view: form }, { view: structuredClone(form) }]), null)
  })
}

test('option groups share one option set, including direct options; initial selections do not', () => {
  const element = { type: 'static_select', action_id: 'select', option_groups: [
    { label: text('Group'), options: [option('one')] }, { label: text('Group 2'), options: [option('two')] },
  ], initial_option: option('one') }
  const form = view({ submit: text('Send'), blocks: [input(element)] })
  assert.equal(check(form), null)
  element.option_groups[1].options[0].value = 'one'
  invalid(form, 'view.blocks[0].element.option_groups[1].options[0].value', 'must be unique within the element options')
  element.option_groups[1].options[0].value = 'v'.repeat(151)
  invalid(form, 'view.blocks[0].element.option_groups[1].options[0].value', 'maximum length 150')
  element.option_groups[1].options[0] = option('two')
  element.option_groups[0].label.text = 'g'.repeat(75)
  assert.equal(check(form), null)
  element.option_groups[0].label.text += 'g'
  invalid(form, 'view.blocks[0].element.option_groups[0].label.text', 'maximum length 75')
  element.option_groups[0].label.text = 'Group'
  element.options = [option('one')]
  invalid(form, 'view.blocks[0].element.option_groups[0].options[0].value', 'must be unique within the element options')
})

test('option and placeholder types and initial selection lengths', () => {
  const element = { type: 'static_select', action_id: 'select', options: [option()], placeholder: text('p'.repeat(150)) }
  const form = view({ submit: text('Send'), blocks: [input(element)] })
  assert.equal(check(form), null)
  element.placeholder.text += 'p'
  invalid(form, 'view.blocks[0].element.placeholder.text', 'maximum length 150')
  delete element.placeholder
  element.options[0].value = 12
  invalid(form, 'view.blocks[0].element.options[0].value', 'must be a string')
  element.options = [option()]; element.initial_option = option('i'.repeat(151))
  invalid(form, 'view.blocks[0].element.initial_option.value', 'maximum length 150')
})

test('plain text input integer bounds and initial value compatibility', () => {
  const element = { type: 'plain_text_input', action_id: 'text', min_length: 0, max_length: 3000, initial_value: 'a'.repeat(3000) }
  const form = view({ submit: text('Send'), blocks: [input(element)] })
  assert.equal(check(form), null)
  element.min_length = 3000
  assert.equal(check(form), null)
  element.min_length = 0
  const minimum = view({ submit: text('Send'), blocks: [input({ type: 'plain_text_input', action_id: 'text', min_length: 0, max_length: 1, initial_value: 'a' })] })
  assert.equal(check(minimum), null)
  for (const [field, values, rule] of [
    ['min_length', [-1, 3001, 1.5, '1'], 'must be an integer between 0 and 3000'],
    ['max_length', [0, 3001, 1.5, '2'], 'must be an integer between 1 and 3000'],
  ]) {
    for (const value of values) {
      const changed = structuredClone(form); changed.blocks[0].element[field] = value
      invalid(changed, `view.blocks[0].element.${field}`, rule)
    }
  }
  element.min_length = 3; element.max_length = 2
  invalid(form, 'view.blocks[0].element.max_length', 'must be greater than or equal to min_length')
  element.max_length = 4; element.initial_value = 'ab'
  invalid(form, 'view.blocks[0].element.initial_value', 'minimum length 3')
  element.initial_value = 'abcde'
  invalid(form, 'view.blocks[0].element.initial_value', 'maximum length 4')
  element.initial_value = '😀😀😀'
  assert.equal(check(form), null)
  delete element.min_length; delete element.max_length; element.initial_value = 'a'.repeat(3001)
  invalid(form, 'view.blocks[0].element.initial_value', 'maximum length 3000')
})

test('number input bounds, decimals and initial value consistency', () => {
  const element = { type: 'number_input', action_id: 'number', is_decimal_allowed: true, min_value: '-1.5', max_value: '2.5', initial_value: '2.5' }
  const form = view({ submit: text('Send'), blocks: [input(element)] })
  assert.equal(check(form), null)
  element.max_value = '-2'
  invalid(form, 'view.blocks[0].element.max_value', 'must be greater than or equal to min_value')
  element.max_value = '2'; element.initial_value = '2.5'
  invalid(form, 'view.blocks[0].element.initial_value', 'must be less than or equal to max_value')
  element.initial_value = '-2'
  invalid(form, 'view.blocks[0].element.initial_value', 'must be greater than or equal to min_value')
  element.initial_value = '1'; element.is_decimal_allowed = false; element.min_value = '0'
  assert.equal(check(form), null)
  element.initial_value = '1.5'
  invalid(form, 'view.blocks[0].element.initial_value', 'must be an integer when is_decimal_allowed is false')
  element.initial_value = 'secret-token'
  invalid(form, 'view.blocks[0].element.initial_value', 'must be a finite numeric string')
})

test('type-aware traversal reaches actions and accessories without imposing a full allowlist', () => {
  const form = view({ blocks: [
    { type: 'section', accessory: { type: 'static_select', action_id: 'select', options: [option('v'.repeat(151))] } },
  ] })
  invalid(form, 'view.blocks[0].accessory.options[0].value', 'maximum length 150')
  form.blocks = [{ type: 'actions', elements: [{ type: 'button', text: text('Go') }] }]
  invalid(form, 'view.blocks[0].elements[0].action_id', 'must be a nonempty string')
  form.blocks = [{ type: 'future_block', options: 'opaque', elements: 'opaque' }]
  assert.equal(check(form), null)
})

test('first error is deterministic; all valid views and unknown fields remain unchanged', () => {
  const form = view({ submit: text('Send'), blocks: [input()], future_field: { token: 'private' } })
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
  }
  freeze(form)
  const modals = [{ callbackId: 'route', view: form }, { view: view() }]
  const before = JSON.stringify(modals)
  assert.equal(validateModalViews(modals), null)
  assert.equal(JSON.stringify(modals), before)
  modals[1].view.title.text = 'secret-token'.repeat(4)
  const expected = 'Invalid value for parameter `modals[1].view.title.text` for send_message: maximum length 24'
  assert.equal(validateModalViews(modals), expected)
  assert.equal(validateModalViews(modals), expected)
  assert.equal(validateModalViews(undefined), null)
  assert.equal(validateModalViews([]), null)
})


test('malformed collections and known fields return safe field paths', () => {
  assert.equal(validateModalViews(null), 'Invalid value for parameter `modals` for send_message: must be an array')
  assert.equal(validateModalViews([null]), 'Invalid value for parameter `modals[0]` for send_message: must be an object')
  invalid(null, 'view', 'must be an object')
  const form = view({ submit: text('Send'), blocks: [input()] })
  for (const value of [null, [], 'SECRET']) {
    form.blocks[0].element = value
    invalid(form, 'view.blocks[0].element', 'must be an object')
  }
  const select = { type: 'static_select', action_id: 'select', options: null }
  form.blocks[0].element = select
  invalid(form, 'view.blocks[0].element.options', 'must be an array')
  select.options = [null]
  invalid(form, 'view.blocks[0].element.options[0]', 'must be an object')
  select.options = [option()]; select.option_groups = null
  invalid(form, 'view.blocks[0].element.option_groups', 'must be an array')
  select.option_groups = [null]
  invalid(form, 'view.blocks[0].element.option_groups[0]', 'must be an object')
  select.option_groups = [{ label: text('Group'), options: null }]
  invalid(form, 'view.blocks[0].element.option_groups[0].options', 'must be an array')
  form.blocks = [{ type: 'actions', elements: null }]
  invalid(form, 'view.blocks[0].elements', 'must be an array')
})

test('noninteractive and future element fields pass through untouched', () => {
  const form = view({ blocks: [
    { type: 'section', accessory: { type: 'image', image_url: 'https://example.invalid/image', alt_text: 'Image' } },
    { type: 'future_block', element: { options: 'unknown' } },
  ] })
  assert.equal(check(form), null)
  form.blocks.push(input({ type: 'future_input', future_data: { options: 'unknown' } }))
  form.submit = text('Send')
  assert.equal(check(form), null)
})

test('number input rejects malformed fields without disclosing their content', () => {
  for (const field of ['min_value', 'max_value', 'initial_value']) {
    for (const value of ['', 'NaN', 'Infinity', 'SECRET_TOKEN', '1e999', null, 1]) {
      invalid(view({ submit: text('Send'), blocks: [input({ type: 'number_input', action_id: 'n', [field]: value })] }), `view.blocks[0].element.${field}`, 'must be a finite numeric string')
    }
  }
  invalid(view({ submit: text('Send'), blocks: [input({ type: 'number_input', action_id: 'n', is_decimal_allowed: 'true' })] }), 'view.blocks[0].element.is_decimal_allowed', 'must be a boolean')
})
