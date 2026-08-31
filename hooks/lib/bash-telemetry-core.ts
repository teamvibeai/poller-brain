/**
 * Orchestration core for the bash-telemetry PostToolUse hook
 * (teamvibeai/teamvibe.ai#341). Split out from ../bash-telemetry.ts (the
 * thin stdin/exit-code entrypoint, mirroring the bash-deny-list-core.ts /
 * bash-deny-list.ts split already established for the sibling PreToolUse
 * hook) so the async network path can be exercised with a dependency-
 * injected `fetch` in tests, instead of spawning a real subprocess.
 *
 * This is pure observability, same "never throws" spirit as
 * emitPipelineEvent's D-06 comment on the teamvibe.ai side: a network
 * failure, missing env var, or non-2xx response must NEVER cause the
 * hook to exit non-zero or block the user's tool call. PostToolUse hooks
 * block the tool result until they exit, so a bounded timeout keeps a
 * hung network call from stalling the user's session.
 */

import { redactSecrets } from './bash-telemetry-redact.js'

export interface HookPayload {
  tool_name?: string
  tool_input?: { command?: string }
}

export interface TelemetryEnv {
  TEAMVIBE_API_URL?: string
  TEAMVIBE_POLLER_TOKEN?: string
  TEAMVIBE_CHANNEL_ID?: string
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>

export interface RunResult {
  posted: boolean
  reason: string
}

const DEFAULT_TIMEOUT_MS = 2000

/**
 * Runs the full hook logic: gate on tool_name/env vars, redact, POST.
 * Never throws — every failure path is caught and reported via the
 * returned `reason`, not an exception. The entrypoint (bash-telemetry.ts)
 * always exits 0 regardless of this function's result.
 */
export async function runBashTelemetryHook(
  payload: HookPayload,
  env: TelemetryEnv,
  fetchImpl: FetchLike,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RunResult> {
  if (payload.tool_name !== 'Bash') {
    return { posted: false, reason: 'not-bash-tool' }
  }

  const command = payload.tool_input?.command
  if (typeof command !== 'string') {
    return { posted: false, reason: 'no-command' }
  }

  const { TEAMVIBE_API_URL, TEAMVIBE_POLLER_TOKEN, TEAMVIBE_CHANNEL_ID } = env
  if (!TEAMVIBE_API_URL || !TEAMVIBE_POLLER_TOKEN || !TEAMVIBE_CHANNEL_ID) {
    return { posted: false, reason: 'missing-env' }
  }

  try {
    const redacted = redactSecrets(command)
    const resp = await fetchImpl(`${TEAMVIBE_API_URL}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEAMVIBE_POLLER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventType: 'bash.command',
        channelId: TEAMVIBE_CHANNEL_ID,
        metadata: { command: redacted },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) {
      return { posted: false, reason: `http-${resp.status}` }
    }
    return { posted: true, reason: 'ok' }
  } catch (err) {
    // Network failure, timeout abort, or anything else — swallow. This is
    // pure observability; it must never propagate out of the hook.
    return { posted: false, reason: err instanceof Error ? err.message : 'unknown-error' }
  }
}
