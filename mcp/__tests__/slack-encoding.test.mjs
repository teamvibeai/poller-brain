// Unit tests for needsFormEncoding()/encodeFormBody() — poller-brain#348.
// Locks the design decision: form-encoding is the default, JSON is a NAMED
// EXCEPTION granted per-method only once confirmed safe (never inferred from a
// namespace or verb — see the code comment above JSON_SAFE_METHODS). Covers the
// 9 confirmed-safe methods currently on the JSON branch, plus two cases that
// guard against silently reintroducing a prefix/namespace rule: an unknown
// method inside an otherwise JSON-safe namespace, and a known-risky read/list
// method inside a namespace that has an unrelated JSON-safe sibling. users.info
// moved to the form branch in poller-brain#349 (live-confirmed to reject JSON
// bodies with user_not_found; users:read scope was never the issue).
// slack.mjs auto-starts a stdio server on import, so we load just the pure
// prelude (everything before the transport section) and export-by-eval the
// helpers. No network, no Slack. Run: node mcp/__tests__/slack-encoding.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'slack.mjs'), 'utf8')
const prelude = src.split('// --- stdio transport ---')[0]
const exports = '\nexport { needsFormEncoding, encodeFormBody }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { needsFormEncoding, encodeFormBody } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

// 1) the 9 confirmed-safe methods on the JSON branch stay there (zero regression)
{
  const jsonSafe = [
    'auth.test',
    'chat.postMessage',
    'chat.update',
    'reactions.add',
    'reactions.remove',
    'pins.add',
    'pins.remove',
    'bookmarks.list',
    'assistant.threads.setStatus',
  ]
  for (const m of jsonSafe) ok(`1 ${m} → JSON (needsFormEncoding=false)`, needsFormEncoding(m) === false)
}

// 2) unknown method in an otherwise JSON-safe namespace → form (no prefix inference)
{
  ok('2 chat.somethingNew → form', needsFormEncoding('chat.somethingNew') === true)
}

// 3) reactions.list (read/list method, sibling of the confirmed-safe reactions.add/remove) → form
{
  ok('3 reactions.list → form', needsFormEncoding('reactions.list') === true)
}

// 4) previously form-encoded methods stay on form (zero regression), plus
//    users.info newly moved to form in poller-brain#349
{
  const formMethods = ['conversations.info', 'conversations.replies', 'conversations.history', 'files.getUploadURLExternal', 'chat.getPermalink', 'pins.list', 'users.info']
  for (const m of formMethods) ok(`4 ${m} → form`, needsFormEncoding(m) === true)
}

// 5) encodeFormBody drops undefined/null values instead of serializing the literal string
{
  const qs = encodeFormBody({ channel: 'C1', thread_ts: undefined, cursor: null, limit: 50 })
  ok('5 undefined key dropped', !qs.includes('undefined'))
  ok('5 null key dropped', !qs.includes('null'))
  ok('5 defined keys survive', qs.includes('channel=C1') && qs.includes('limit=50'))
}

// 6) encodeFormBody still JSON-stringifies object values (blocks/attachments etc.)
{
  const qs = encodeFormBody({ blocks: [{ type: 'section' }] })
  ok('6 object value JSON-stringified', decodeURIComponent(qs) === `blocks=${JSON.stringify([{ type: 'section' }])}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
