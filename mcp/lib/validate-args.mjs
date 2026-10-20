// Deliberately shallow: validate tool parameters and their immediate children,
// including array-item required fields, without inspecting Block Kit/view contents.

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) {
      next[j + 1] = Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]
}

function suggestParameter(key, allowed) {
  const normalize = (s) => s.replace(/_/g, '').toLowerCase()
  const normalized = normalize(key)
  let best = null
  let bestDistance = 3
  for (const candidate of allowed) {
    const target = normalize(candidate)
    if (Math.abs(normalized.length - target.length) > 2) continue
    const distance = editDistance(normalized, target)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function valueType(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}

function typeError(value, schema, path, toolName) {
  if (!schema.type) return null
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const actual = valueType(value)
  if (types.includes(actual) && (actual !== 'number' || Number.isFinite(value))) return null
  return `Invalid type for parameter \`${path}\` for ${toolName}: expected ${types.join(' or ')}, got ${actual}`
}

// Check only required keys and the types of declared properties at this level.
// Unknown nested keys stay allowed; only the tool's top-level keys are closed.
function objectError(value, schema, path, toolName) {
  const childPath = (key) => path ? `${path}.${key}` : key
  for (const key of schema.required || []) {
    if (!Object.hasOwn(value, key)) return `Missing required parameter \`${childPath(key)}\` for ${toolName}`
  }
  for (const [key, property] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(value, key)) continue
    const error = typeError(value[key], property, childPath(key), toolName)
    if (error) return error
  }
  return null
}

// Return an actionable error string, or null. The caller keeps MCP's existing
// tool-error envelope and skips this entirely for unknown tool names.
export function validateArgs(toolName, args, schema) {
  const rootError = typeError(args, schema, 'arguments', toolName)
  if (rootError) return rootError
  const properties = schema.properties || {}
  const allowed = Object.keys(properties)
  for (const key of Object.keys(args)) {
    if (Object.hasOwn(properties, key)) continue
    const suggestion = suggestParameter(key, allowed)
    return `Unknown parameter \`${key}\` for ${toolName}. Allowed parameters: ${allowed.join(', ')}.` +
      (suggestion ? ` Did you mean \`${suggestion}\`?` : '')
  }
  const error = objectError(args, schema, '', toolName)
  if (error) return error
  for (const [key, property] of Object.entries(properties)) {
    if (!Object.hasOwn(args, key)) continue
    const value = args[key]
    if (valueType(value) === 'object') {
      const error = objectError(value, property, key, toolName)
      if (error) return error
    } else if (Array.isArray(value) && property.items) {
      for (let i = 0; i < value.length; i++) {
        const path = `${key}[${i}]`
        const error = typeError(value[i], property.items, path, toolName) ||
          (valueType(value[i]) === 'object' ? objectError(value[i], property.items, path, toolName) : null)
        if (error) return error
      }
    }
  }
  return null
}
