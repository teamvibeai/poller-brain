// Small, dependency-free validator for the schemas declared by our MCP servers.
// Returns an error string or null. Checks the argument object and one level of
// declared object/array-item fields; Block Kit and modal view contents stay loose.

function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)))
    }
    row = next
  }
  return row[b.length]
}

function suggestKey(key, allowed) {
  const normalize = (s) => s.replace(/_/g, '').toLowerCase()
  const normalized = normalize(key)
  const variant = allowed.find((candidate) => normalize(candidate) === normalized)
  if (variant) return variant
  let best, distance = 3
  for (const candidate of allowed) {
    const d = editDistance(normalized, normalize(candidate))
    if (d < distance) {
      best = candidate
      distance = d
    }
  }
  return best
}

function checkValue(value, schema, path, toolName) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const actual = valueType(value)
  if (types.length && (!types.includes(actual) || (actual === 'number' && !Number.isFinite(value)))) {
    return `Invalid type for parameter \`${path}\` for ${toolName}: expected ${types.join(' or ')}, got ${actual}`
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `Invalid value for parameter \`${path}\` for ${toolName}. Allowed values: ${schema.enum.join(', ')}`
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    return `Invalid value for parameter \`${path}\` for ${toolName}: minimum ${schema.minimum}`
  }
  return null
}

// Only examines this object's own required/declared fields, without recursing.
function checkFields(value, schema, prefix, toolName) {
  const pathFor = (key) => prefix ? `${prefix}.${key}` : key
  for (const key of schema.required || []) {
    if (!Object.hasOwn(value, key)) {
      return `Missing required parameter \`${pathFor(key)}\` for ${toolName}`
    }
  }
  for (const [key, field] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(value, key)) continue
    const error = checkValue(value[key], field, pathFor(key), toolName)
    if (error) return error
  }
  return null
}

export function validateArgs(tool, args) {
  const { name, inputSchema: schema } = tool
  if (valueType(args) !== 'object') return `Arguments for ${name} must be an object`
  const allowed = Object.keys(schema.properties || {})
  for (const key of Object.keys(args)) {
    if (Object.hasOwn(schema.properties || {}, key)) continue
    const suggestion = suggestKey(key, allowed)
    return `Unknown parameter \`${key}\` for ${name}. Allowed parameters: ${allowed.join(', ')}.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`
  }
  const error = checkFields(args, schema, '', name)
  if (error) return error
  for (const [key, field] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(args, key)) continue
    const value = args[key]
    if (Array.isArray(value) && field.items) {
      for (let i = 0; i < value.length; i++) {
        const path = `${key}[${i}]`
        const error = checkValue(value[i], field.items, path, name)
          || (valueType(value[i]) === 'object' ? checkFields(value[i], field.items, path, name) : null)
        if (error) return error
      }
    } else if (valueType(value) === 'object') {
      const error = checkFields(value, field, key, name)
      if (error) return error
    }
  }
  return null
}
