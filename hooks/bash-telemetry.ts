#!/usr/bin/env npx tsx
/**
 * PostToolUse hook for the Bash tool — emits one `bash.command` pipeline
 * event per invocation for observability (teamvibeai/teamvibe.ai#341,
 * sub-issue of the tool-lifecycle telemetry epic #52).
 *
 * See hooks/lib/bash-telemetry-core.ts (orchestration + never-throws
 * network path) and hooks/lib/bash-telemetry-redact.ts (secret-shaped
 * substring redaction applied to the command text before it's sent) for
 * the actual logic — this file is a thin stdin-JSON / exit-code wrapper.
 *
 * Wired via settings.json:
 *   hooks.PostToolUse[] matcher "Bash" -> this script.
 *
 * Contract (matches the existing PreToolUse precedent in this repo, e.g.
 * hooks/bash-deny-list.ts): read the tool-call JSON from stdin. Unlike
 * that hook, this one NEVER blocks — PostToolUse hooks aren't meant to
 * deny (that's PreToolUse's job), so this always exits 0, regardless of
 * whether the POST succeeded, failed, or was skipped. Sequencing note:
 * this hook must not be wired on before the teamvibe.ai side accepts
 * `bash.command` on /events (see ALLOWED_EVENT_TYPES in
 * packages/modules-teamvibe/src/hooks/poller-events.ts) — mirrors the
 * tv#127 incident where the reverse order caused a 400-error loop.
 */

import { runBashTelemetryHook, type FetchLike, type HookPayload } from './lib/bash-telemetry-core.js'

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

async function main(): Promise<void> {
  let raw: string
  try {
    raw = await readStdin()
  } catch {
    process.exit(0)
    return
  }

  let payload: HookPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    process.exit(0)
    return
  }

  // Never throws (see bash-telemetry-core.ts) — but wrap anyway so a
  // future change to that contract can't turn into a blocked tool call.
  try {
    await runBashTelemetryHook(payload, process.env, fetch as unknown as FetchLike)
  } catch {
    // fall through to exit 0 below regardless
  }

  process.exit(0)
}

main()
