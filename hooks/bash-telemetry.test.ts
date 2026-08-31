#!/usr/bin/env npx tsx
/**
 * Self-test for hooks/lib/bash-telemetry-core.ts (the async orchestration
 * behind hooks/bash-telemetry.ts). Run: npx tsx hooks/bash-telemetry.test.ts
 * Exits non-zero on the first failed assertion. Same hand-rolled style as
 * hooks/bash-deny-list.test.ts — this repo's established convention.
 *
 * Tests inject a fake `fetch` (dependency injection, per bash-telemetry-
 * core.ts's FetchLike parameter) rather than spawning the real script —
 * spawning would need to mock global fetch across a process boundary,
 * which this repo's plain-node test style doesn't support.
 */

import { runBashTelemetryHook, type FetchLike, type HookPayload, type TelemetryEnv } from "./lib/bash-telemetry-core.js";

let passed = 0;
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL (${label}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  passed++;
}

const FULL_ENV: TelemetryEnv = {
  TEAMVIBE_API_URL: "https://api.example.com",
  TEAMVIBE_POLLER_TOKEN: "poller-token-123",
  TEAMVIBE_CHANNEL_ID: "ch-1",
};

function neverCalledFetch(): FetchLike {
  return async () => {
    console.error("FAIL: fetch should not have been called");
    process.exit(1);
  };
}

async function main(): Promise<void> {
  // --- non-Bash tool_name is a no-op, fetch never called --------------------
  {
    const payload: HookPayload = { tool_name: "Read", tool_input: {} as any };
    const result = await runBashTelemetryHook(payload, FULL_ENV, neverCalledFetch());
    assertEqual(result, { posted: false, reason: "not-bash-tool" }, "non-Bash tool_name no-op");
  }

  // --- missing tool_input.command is a no-op ---------------------------------
  {
    const payload: HookPayload = { tool_name: "Bash", tool_input: {} };
    const result = await runBashTelemetryHook(payload, FULL_ENV, neverCalledFetch());
    assertEqual(result, { posted: false, reason: "no-command" }, "missing command no-op");
  }

  // --- missing env vars is a no-op (each var individually) -------------------
  {
    const payload: HookPayload = { tool_name: "Bash", tool_input: { command: "echo hi" } };
    const cases: [string, TelemetryEnv][] = [
      ["missing TEAMVIBE_API_URL", { ...FULL_ENV, TEAMVIBE_API_URL: undefined }],
      ["missing TEAMVIBE_POLLER_TOKEN", { ...FULL_ENV, TEAMVIBE_POLLER_TOKEN: undefined }],
      ["missing TEAMVIBE_CHANNEL_ID", { ...FULL_ENV, TEAMVIBE_CHANNEL_ID: undefined }],
      ["all env vars missing", {}],
    ];
    for (const [label, env] of cases) {
      const result = await runBashTelemetryHook(payload, env, neverCalledFetch());
      assertEqual(result, { posted: false, reason: "missing-env" }, label);
    }
  }

  // --- successful POST includes redacted command ------------------------------
  {
    const payload: HookPayload = {
      tool_name: "Bash",
      tool_input: { command: "export FOO_TOKEN=abc123 && echo done" },
    };
    let capturedUrl: string | undefined;
    let capturedInit: Record<string, unknown> | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200 };
    };

    const result = await runBashTelemetryHook(payload, FULL_ENV, fetchImpl);
    assertEqual(result, { posted: true, reason: "ok" }, "successful POST result");
    assertEqual(capturedUrl, "https://api.example.com/events", "POST url");

    const body = JSON.parse((capturedInit as any).body);
    assertEqual(body.eventType, "bash.command", "POST body eventType");
    assertEqual(body.channelId, "ch-1", "POST body channelId");
    if (body.metadata.command.includes("abc123")) {
      console.error(`FAIL: secret leaked into POST body: ${body.metadata.command}`);
      process.exit(1);
    }
    if (!body.metadata.command.includes("[REDACTED]")) {
      console.error(`FAIL: expected redaction marker in POST body: ${body.metadata.command}`);
      process.exit(1);
    }
    passed++;
    const headers = (capturedInit as any).headers;
    assertEqual(headers.Authorization, "Bearer poller-token-123", "POST Authorization header");
  }

  // --- non-2xx response does not throw, reason reflects status ---------------
  {
    const payload: HookPayload = { tool_name: "Bash", tool_input: { command: "echo hi" } };
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500 });
    const result = await runBashTelemetryHook(payload, FULL_ENV, fetchImpl);
    assertEqual(result, { posted: false, reason: "http-500" }, "non-2xx response");
  }

  // --- fetch throwing does not propagate/throw out of the hook ----------------
  {
    const payload: HookPayload = { tool_name: "Bash", tool_input: { command: "echo hi" } };
    const fetchImpl: FetchLike = async () => {
      throw new Error("network unreachable");
    };
    let threw = false;
    let result: Awaited<ReturnType<typeof runBashTelemetryHook>> | undefined;
    try {
      result = await runBashTelemetryHook(payload, FULL_ENV, fetchImpl);
    } catch {
      threw = true;
    }
    if (threw) {
      console.error("FAIL: runBashTelemetryHook threw when fetch rejected");
      process.exit(1);
    }
    assertEqual(result, { posted: false, reason: "network unreachable" }, "fetch throws -> swallowed");
  }

  // --- fetch never resolving within timeout does not hang ---------------------
  // Uses a short 50ms hook-level timeout (not the real 2000ms default) so this
  // test runs fast. fetchImpl here mimics what a real fetch does when its
  // AbortSignal fires: rejects with an AbortError. runBashTelemetryHook itself
  // just needs to not hang waiting on a promise that never settles on its own.
  {
    const payload: HookPayload = { tool_name: "Bash", tool_input: { command: "sleep 999" } };
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as any)?.signal as AbortSignal | undefined;
        // A real hanging fetch would keep the event loop alive via its open
        // socket. AbortSignal.timeout()'s internal timer is deliberately
        // unref'd (so a hook process can still exit promptly on its own even
        // if a POST never settles) — without something else ref'd here, Node
        // would exit this *test* process the instant the synchronous setup
        // above finishes, before the 50ms abort timer ever fires. This
        // ref'd keep-alive timer stands in for that open socket and is
        // cleared as soon as the abort fires, so it never actually delays
        // the test itself.
        const keepAlive = setTimeout(() => {}, 5000);
        signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new Error("The operation was aborted"));
        });
        // Deliberately never resolves/rejects on its own otherwise — only
        // the abort signal (driven by the timeoutMs passed below) should
        // end this.
      });

    const start = Date.now();
    const result = await runBashTelemetryHook(payload, FULL_ENV, fetchImpl, 50);
    const elapsed = Date.now() - start;
    if (elapsed > 1000) {
      console.error(`FAIL: hook took ${elapsed}ms, expected to abort near the 50ms timeout`);
      process.exit(1);
    }
    assertEqual(result.posted, false, "timeout does not post");
    passed++;
  }

  console.log(`OK: ${passed} assertions passed`);
}

main();
