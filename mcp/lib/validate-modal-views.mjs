// Bounded, pure modal checks for send_message. Returns the first field-path
// error or null; never modifies views or includes supplied values in errors.
// Unknown Slack fields/types pass through. This is not a Block Kit allowlist.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const length = value => [...value].length // Unicode code points, not UTF-16 units.
const error = (path, rule) => `Invalid value for parameter \`${path}\` for send_message: ${rule}`

function string(value, path, max, min = 0) {
  if (typeof value !== 'string') return error(path, 'must be a string')
  const size = length(value)
  if (size < min) return error(path, `minimum length ${min}`)
  if (size > max) return error(path, `maximum length ${max}`)
  return null
}

function text(value, path, max, plain = false) {
  if (!isObject(value)) return error(path, 'must be an object')
  if (plain && value.type !== 'plain_text') return error(`${path}.type`, 'must be plain_text')
  return string(value.text, `${path}.text`, max, 1)
}

function array(value, path) {
  return Array.isArray(value) ? null : error(path, 'must be an array')
}

const actionTypes = new Set([
  'button', 'overflow', 'plain_text_input', 'number_input', 'email_text_input',
  'url_text_input', 'rich_text_input', 'file_input', 'static_select',
  'multi_static_select', 'external_select', 'multi_external_select',
  'users_select', 'multi_users_select', 'conversations_select',
  'multi_conversations_select', 'channels_select', 'multi_channels_select',
  'radio_buttons', 'checkboxes', 'datepicker', 'timepicker', 'datetimepicker',
])
const optionTypes = new Set(['static_select', 'multi_static_select', 'external_select', 'multi_external_select', 'radio_buttons', 'checkboxes', 'overflow'])

function option(value, path, seen) {
  if (!isObject(value)) return error(path, 'must be an object')
  const invalid = string(value.value, `${path}.value`, 150, 1) || text(value.text, `${path}.text`, 75)
  if (invalid) return invalid
  if (seen?.has(value.value)) return error(`${path}.value`, 'must be unique within the element options')
  seen?.add(value.value)
  return null
}

function options(values, path, seen) {
  const invalid = array(values, path)
  if (invalid) return invalid
  for (let i = 0; i < values.length; i++) {
    const invalid = option(values[i], `${path}[${i}]`, seen)
    if (invalid) return invalid
  }
  return null
}

function plainTextInput(value, path) {
  // Slack plain_text_input length bounds: min_length 0..3000,
  // max_length 1..3000; an omitted max still has the 3000-character ceiling.
  for (const [field, min] of [['min_length', 0], ['max_length', 1]]) {
    if (Object.hasOwn(value, field) && (!Number.isInteger(value[field]) || value[field] < min || value[field] > 3000)) {
      return error(`${path}.${field}`, `must be an integer between ${min} and 3000`)
    }
  }
  if (value.min_length !== undefined && value.max_length !== undefined && value.min_length > value.max_length) {
    return error(`${path}.max_length`, 'must be greater than or equal to min_length')
  }
  return Object.hasOwn(value, 'initial_value')
    ? string(value.initial_value, `${path}.initial_value`, value.max_length ?? 3000, value.min_length ?? 0)
    : null
}

function numberInput(value, path) {
  if (Object.hasOwn(value, 'is_decimal_allowed') && typeof value.is_decimal_allowed !== 'boolean') {
    return error(`${path}.is_decimal_allowed`, 'must be a boolean')
  }
  const numbers = {}
  for (const field of ['min_value', 'max_value', 'initial_value']) {
    if (!Object.hasOwn(value, field)) continue
    const number = value[field]
    if (typeof number !== 'string' || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(number) || !Number.isFinite(Number(number))) {
      return error(`${path}.${field}`, 'must be a finite numeric string')
    }
    numbers[field] = Number(number)
    if (value.is_decimal_allowed === false && !Number.isInteger(numbers[field])) {
      return error(`${path}.${field}`, 'must be an integer when is_decimal_allowed is false')
    }
  }
  if (numbers.min_value !== undefined && numbers.max_value !== undefined && numbers.min_value > numbers.max_value) {
    return error(`${path}.max_value`, 'must be greater than or equal to min_value')
  }
  if (numbers.initial_value !== undefined) {
    if (numbers.min_value !== undefined && numbers.initial_value < numbers.min_value) {
      return error(`${path}.initial_value`, 'must be greater than or equal to min_value')
    }
    if (numbers.max_value !== undefined && numbers.initial_value > numbers.max_value) {
      return error(`${path}.initial_value`, 'must be less than or equal to max_value')
    }
  }
  return null
}

function element(value, path) {
  if (!isObject(value)) return error(path, 'must be an object')
  if (actionTypes.has(value.type) && (typeof value.action_id !== 'string' || !value.action_id.trim())) {
    return error(`${path}.action_id`, 'must be a nonempty string')
  }
  if (actionTypes.has(value.type) && Object.hasOwn(value, 'placeholder')) {
    const invalid = text(value.placeholder, `${path}.placeholder`, 150, true)
    if (invalid) return invalid
  }
  if (optionTypes.has(value.type)) {
    const seen = new Set()
    if (Object.hasOwn(value, 'options')) {
      const invalid = options(value.options, `${path}.options`, seen)
      if (invalid) return invalid
    }
    if (Object.hasOwn(value, 'option_groups')) {
      const invalid = array(value.option_groups, `${path}.option_groups`)
      if (invalid) return invalid
      for (let i = 0; i < value.option_groups.length; i++) {
        const group = value.option_groups[i], groupPath = `${path}.option_groups[${i}]`
        if (!isObject(group)) return error(groupPath, 'must be an object')
        const invalid = text(group.label, `${groupPath}.label`, 75, true) || options(group.options, `${groupPath}.options`, seen)
        if (invalid) return invalid
      }
    }
    // Initial selections refer to the declared set; do not count them as new
    // declarations when checking option-value uniqueness.
    if (Object.hasOwn(value, 'initial_option')) {
      const invalid = option(value.initial_option, `${path}.initial_option`)
      if (invalid) return invalid
    }
    if (Object.hasOwn(value, 'initial_options')) {
      const invalid = options(value.initial_options, `${path}.initial_options`)
      if (invalid) return invalid
    }
  }
  if (value.type === 'plain_text_input') return plainTextInput(value, path)
  if (value.type === 'number_input') return numberInput(value, path)
  return null
}

function view(value, path) {
  if (!isObject(value)) return error(path, 'must be an object')
  if (value.type !== 'modal') return error(`${path}.type`, 'must be modal')
  for (const field of ['title', 'submit', 'close']) {
    if (field !== 'title' && !Object.hasOwn(value, field)) continue
    const invalid = text(value[field], `${path}.${field}`, 24, true)
    if (invalid) return invalid
  }
  for (const [field, max] of [['callback_id', 255], ['private_metadata', 3000]]) {
    if (!Object.hasOwn(value, field)) continue
    const invalid = string(value[field], `${path}.${field}`, max)
    if (invalid) return invalid
  }
  const invalid = array(value.blocks, `${path}.blocks`)
  if (invalid) return invalid
  if (value.blocks.length > 100) return error(`${path}.blocks`, 'maximum items 100')
  if (value.blocks.some(block => block?.type === 'input') && !Object.hasOwn(value, 'submit')) {
    return error(`${path}.submit`, 'required when blocks contain inputs')
  }
  const blockIds = new Set()
  for (let i = 0; i < value.blocks.length; i++) {
    const block = value.blocks[i], blockPath = `${path}.blocks[${i}]`
    if (!isObject(block)) return error(blockPath, 'must be an object')
    if (block.type === 'input' || Object.hasOwn(block, 'block_id')) {
      if (typeof block.block_id !== 'string' || !block.block_id.trim()) return error(`${blockPath}.block_id`, 'must be a nonempty string')
      if (blockIds.has(block.block_id)) return error(`${blockPath}.block_id`, 'must be unique within the view')
      blockIds.add(block.block_id)
    }
    if (block.type === 'input') {
      const invalid = element(block.element, `${blockPath}.element`)
      if (invalid) return invalid
    }
    if (block.type === 'section' && Object.hasOwn(block, 'accessory')) {
      const invalid = element(block.accessory, `${blockPath}.accessory`)
      if (invalid) return invalid
    }
    if (block.type === 'actions') {
      const invalid = array(block.elements, `${blockPath}.elements`)
      if (invalid) return invalid
      for (let j = 0; j < block.elements.length; j++) {
        const invalid = element(block.elements[j], `${blockPath}.elements[${j}]`)
        if (invalid) return invalid
      }
    }
  }
  return null
}

// The shared validateArgs runs first at the MCP boundary. Keeping this entry
// point defensive also makes the pure validator safe to use independently.
export function validateModalViews(modals) {
  if (modals === undefined) return null
  const invalid = array(modals, 'modals')
  if (invalid) return invalid
  for (let i = 0; i < modals.length; i++) {
    const modal = modals[i], path = `modals[${i}]`
    if (!isObject(modal)) return error(path, 'must be an object')
    if (Object.hasOwn(modal, 'callbackId')) {
      const invalid = string(modal.callbackId, `${path}.callbackId`, 255)
      if (invalid) return invalid
    }
    const invalid = view(modal.view, `${path}.view`)
    if (invalid) return invalid
  }
  return null
}
