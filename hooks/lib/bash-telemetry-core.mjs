/**
 * Best-effort bash.command telemetry. No output, retries, or exception messages:
 * failures must not block tool results or expose commands/credentials in logs.
 * Prepare only the receiver's four metadata fields, then deliver in a worker.
 * Inject fetch for tests; the deadline also bounds clients that ignore abort.
 */
import { redactSecrets } from "./bash-telemetry-redact.mjs";

const DEFAULT_TIMEOUT_MS = 2000;
export const MAX_COMMAND_LENGTH = 64 * 1024;

function isUtcTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function prepareBashTelemetryHook(payload, env, receivedAt = new Date().toISOString()) {
  try {
    if (payload?.tool_name !== "Bash") {
      return { posted: false, reason: "not-bash-tool" };
    }
    const command = payload.tool_input?.command;
    if (typeof command !== "string") {
      return { posted: false, reason: "no-command" };
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      return { posted: false, reason: "command-too-large" };
    }
    const { TEAMVIBE_API_URL, TEAMVIBE_POLLER_TOKEN, TEAMVIBE_CHANNEL_ID } = env ?? {};
    if (![TEAMVIBE_API_URL, TEAMVIBE_POLLER_TOKEN, TEAMVIBE_CHANNEL_ID]
      .every(value => typeof value === "string" && value.length > 0)) {
      return { posted: false, reason: "missing-env" };
    }

    // Redaction is deliberately conservative about unsupported shell syntax.
    const redact = value => redactSecrets(value).split(TEAMVIBE_POLLER_TOKEN).join("[REDACTED]");
    const cwd = typeof payload.cwd === "string" && payload.cwd.trim() && payload.cwd.length <= 1024
      ? redact(payload.cwd) : "[UNKNOWN]";
    const response = payload.tool_response;
    const exitCode = [response?.exit_code, response?.exitCode].find(Number.isSafeInteger) ?? -1;
    return { event: {
      eventType: "bash.command",
      channelId: TEAMVIBE_CHANNEL_ID,
      metadata: {
        command: command.trim() ? redact(command) : "[EMPTY COMMAND]",
        cwd: cwd.length <= 1024 ? cwd : "[UNKNOWN]",
        // PostToolUse may omit an exit status or invocation timestamp. -1 is
        // unknown, never assumed success; receivedAt is captured by the parent.
        exitCode,
        invokedAt: isUtcTimestamp(payload.invokedAt) ? payload.invokedAt : receivedAt,
      },
    } };
  } catch {
    return { posted: false, reason: "error" };
  }
}

export async function deliverBashTelemetryEvent(event, env, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer;
  const controller = new AbortController();
  try {
    const { TEAMVIBE_API_URL, TEAMVIBE_POLLER_TOKEN } = env;
    const duration = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve({ posted: false, reason: "timeout" });
        controller.abort();
      }, duration);
    });
    const post = async () => {
      const resp = await fetchImpl(`${TEAMVIBE_API_URL.replace(/\/$/, "")}/events`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${TEAMVIBE_POLLER_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      return resp.ok ? { posted: true, reason: "ok" }
        : { posted: false, reason: `http-${resp.status}` };
    };
    return await Promise.race([post(), timeout]);
  } catch {
    return { posted: false, reason: "error" };
  } finally {
    clearTimeout(timer);
    // Release an unread response body/socket as well as timed-out requests.
    controller.abort();
  }
}

export async function runBashTelemetryHook(payload, env, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const prepared = prepareBashTelemetryHook(payload, env);
  return prepared.event ? deliverBashTelemetryEvent(prepared.event, env, fetchImpl, timeoutMs) : prepared;
}
