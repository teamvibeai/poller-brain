/**
 * Best-effort bash.command telemetry. No output, retries, or exception messages:
 * failures must not block tool results or expose commands/credentials in logs.
 * Inject fetch for tests; the deadline also bounds clients that ignore abort.
 */
import { redactSecrets } from "./bash-telemetry-redact.mjs";

const DEFAULT_TIMEOUT_MS = 2000;
export const MAX_COMMAND_LENGTH = 64 * 1024;

export async function runBashTelemetryHook(payload, env, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer;
  const controller = new AbortController();
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
    const redacted = redactSecrets(command).split(TEAMVIBE_POLLER_TOKEN).join("[REDACTED]");
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
        body: JSON.stringify({
          eventType: "bash.command",
          channelId: TEAMVIBE_CHANNEL_ID,
          metadata: { command: redacted },
        }),
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
