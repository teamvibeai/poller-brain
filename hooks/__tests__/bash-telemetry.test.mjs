#!/usr/bin/env node
// Run: node hooks/__tests__/bash-telemetry.test.mjs
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runBashTelemetryHook, MAX_COMMAND_LENGTH } from "../lib/bash-telemetry-core.mjs";

const FULL_ENV = {
  TEAMVIBE_API_URL: "https://api.example.com",
  TEAMVIBE_POLLER_TOKEN: "poller-token-123",
  TEAMVIBE_CHANNEL_ID: "ch-1",
};
const INVOKED_AT = "2026-11-05T12:00:00.000Z";
const payload = command => ({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp/project", invokedAt: INVOKED_AT });
const neverFetch = () => assert.fail("fetch should not have been called");

// Validation rules from teamvibe.ai origin/main 7587e28,
// bash-command.ts sanitizeBashCommandMetadata. Keep this in sync
// with the receiver: four fields, nonempty strings, bounded cwd, safe integer,
// and a round-trippable ISO UTC timestamp (millisecond precision).
function assertPlatformMetadata(metadata) {
  assert.deepEqual(Object.keys(metadata).sort(), ["command", "cwd", "exitCode", "invokedAt"]);
  assert.equal(typeof metadata.command, "string");
  assert.ok(metadata.command.trim());
  assert.equal(typeof metadata.cwd, "string");
  assert.ok(metadata.cwd.trim());
  assert.ok(metadata.cwd.length <= 1024);
  assert.ok(Number.isSafeInteger(metadata.exitCode));
  assert.match(metadata.invokedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(metadata.invokedAt).toISOString(), metadata.invokedAt);
}

for (const input of [null, undefined, [], {}, { tool_name: "Read" }]) {
  test(`ignores non-Bash payload ${JSON.stringify(input)}`, async () => {
    assert.deepEqual(await runBashTelemetryHook(input, FULL_ENV, neverFetch),
      { posted: false, reason: "not-bash-tool" });
  });
}
for (const input of [{ tool_name: "Bash" }, payload(null), payload(123)]) {
  test(`ignores missing or invalid command ${JSON.stringify(input)}`, async () => {
    assert.deepEqual(await runBashTelemetryHook(input, FULL_ENV, neverFetch),
      { posted: false, reason: "no-command" });
  });
}
for (const key of Object.keys(FULL_ENV)) {
  test(`ignores missing ${key}`, async () => {
    assert.deepEqual(await runBashTelemetryHook(payload("echo hi"), { ...FULL_ENV, [key]: undefined }, neverFetch),
      { posted: false, reason: "missing-env" });
  });
}
test("ignores entirely missing environment", async () => {
  assert.deepEqual(await runBashTelemetryHook(payload("echo hi"), undefined, neverFetch),
    { posted: false, reason: "missing-env" });
});
test("skips oversized commands before redaction or fetch", async () => {
  assert.deepEqual(await runBashTelemetryHook(payload("a".repeat(MAX_COMMAND_LENGTH + 1)), FULL_ENV, neverFetch),
    { posted: false, reason: "command-too-large" });
});
test("POST contract includes the four platform metadata fields", async () => {
  const result = await runBashTelemetryHook({ ...payload('export TOKEN=first"second third"'),
    tool_response: { stdout: "response-secret", stderr: "error-secret", exit_code: 7 },
  }, { ...FULL_ENV, TEAMVIBE_API_URL: FULL_ENV.TEAMVIBE_API_URL + "/" }, async (url, init) => {
    assert.equal(url, "https://api.example.com/events");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, {
      Authorization: "Bearer poller-token-123", "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(init.body), {
      eventType: "bash.command", channelId: "ch-1", metadata: {
        command: "export [REDACTED]", cwd: "/tmp/project", exitCode: 7, invokedAt: INVOKED_AT,
      },
    });
    assert.ok(init.signal instanceof AbortSignal);
    return { ok: true, status: 200 };
  });
  assert.deepEqual(result, { posted: true, reason: "ok" });
});
test("payload meets the platform sanitizer rules, including missing/invalid field fallbacks", async () => {
  for (const input of [
    { ...payload("echo hi"), tool_response: { exit_code: 3 } },
    { ...payload("echo hi"), tool_response: { exitCode: 9 } },
    { tool_name: "Bash", tool_input: { command: "" } },
    { ...payload(" "), cwd: " ", invokedAt: "invalid", tool_response: { exit_code: "0" } },
    { ...payload("echo hi"), cwd: "x".repeat(1025), invokedAt: "2026-02-30T00:00:00.000Z",
      tool_response: { exit_code: 1.5 } },
  ]) {
    let metadata;
    const before = Date.now();
    const result = await runBashTelemetryHook(input, FULL_ENV, async (_url, init) => {
      metadata = JSON.parse(init.body).metadata;
      return { ok: true };
    });
    assert.equal(result.posted, true);
    assertPlatformMetadata(metadata);
    assert.equal(metadata.exitCode, input.tool_response?.exit_code === 3 ? 3 : input.tool_response?.exitCode === 9 ? 9 : -1);
    if (input.invokedAt === INVOKED_AT) assert.equal(metadata.invokedAt, INVOKED_AT);
    else assert.ok(Date.parse(metadata.invokedAt) >= before && Date.parse(metadata.invokedAt) <= Date.now());
  }
});
test("masks the configured auth token even without a signature", async () => {
  const result = await runBashTelemetryHook(payload("echo poller-token-123"), FULL_ENV, async (_url, init) => {
    assert.equal(JSON.parse(init.body).metadata.command, "echo [REDACTED]");
    return { ok: true };
  });
  assert.equal(result.posted, true);
});
test("non-2xx responses fail open", async () => {
  for (const status of [400, 401, 500]) {
    assert.deepEqual(await runBashTelemetryHook(payload("echo hi"), FULL_ENV, async () => ({ ok: false, status })),
      { posted: false, reason: `http-${status}` });
  }
});
test("network rejections and synchronous exceptions never expose error text", async () => {
  for (const fetchImpl of [() => { throw new Error("secret exception"); }, async () => { throw "secret rejection"; }]) {
    assert.deepEqual(await runBashTelemetryHook(payload("echo hi"), FULL_ENV, fetchImpl),
      { posted: false, reason: "error" });
  }
});
test("bounds stalled fetch even when abort is ignored", async () => {
  let signal;
  const start = Date.now();
  const result = await runBashTelemetryHook(payload("echo hi"), FULL_ENV, (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  }, 50);
  assert.deepEqual(result, { posted: false, reason: "timeout" });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - start < 1000);
});
test("abort-aware fetch also times out without throwing", async () => {
  const result = await runBashTelemetryHook(payload("echo hi"), FULL_ENV, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("secret abort error")), { once: true });
  }), 50);
  assert.deepEqual(result, { posted: false, reason: "timeout" });
});

// Invoke the configured command through a shell, with spaces in its config path.
// This checks discovery/invocation and the actual stdin/exit-code contract.
const settings = JSON.parse(readFileSync(new URL("../../settings.json", import.meta.url), "utf8"));
const command = settings.hooks.PostToolUse.find(entry => entry.matcher === "Bash").hooks[0].command;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), "telemetry config "));
symlinkSync(join(repo, "hooks"), join(configDir, "hooks"), "dir");
after(() => rmSync(configDir, { recursive: true, force: true }));
function invoke(input, env = {}, leaveStdinOpen = false, hookCommand = command) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn("sh", ["-c", hookCommand], {
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("hook exceeded deadline")); }, 5000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      try { assert.deepEqual({ code, signal, stdout, stderr }, { code: 0, signal: null, stdout: "", stderr: "" }); resolve(performance.now() - start); }
      catch (error) { reject(error); }
    });
    if (leaveStdinOpen) child.stdin.write(input);
    else child.stdin.end(input);
  });
}

test("configured hook is dependency-free Node", () => {
  assert.equal(command, 'node "$CLAUDE_CONFIG_DIR/hooks/bash-telemetry.mjs"');
});
test("entrypoint fails open silently for malformed input and missing env", async () => {
  for (const input of ["", "{", "null", "[]", "123", '{"tool_name":"Read"}',
    '{"tool_name":"Bash","tool_input":null}', JSON.stringify(payload("echo hi"))]) {
    await invoke(input);
  }
});
test("entrypoint bounds oversized stdin", async () => {
  await invoke(" ".repeat(256 * 1024 + 1));
});
test("entrypoint deadline covers stdin that never ends", async () => {
  await invoke("{", {}, true);
});
test("entrypoint posts redacted data to HTTP and bounds a stalled server", async t => {
  let seen = 0;
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      seen++;
      assert.equal(req.url, "/events");
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer poller-token-123");
      const body = JSON.parse(raw);
      assert.deepEqual(body, { eventType: "bash.command", channelId: "ch-1", metadata: {
        command: "export [REDACTED]", cwd: "/tmp/project", exitCode: -1, invokedAt: INVOKED_AT,
      } });
      requests.push(body);
      if (seen === 1) { res.writeHead(204); res.end(); }
      else if (seen === 2) { res.writeHead(500); res.end(); }
      // Third request intentionally never responds.
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...FULL_ENV, TEAMVIBE_API_URL: `http://127.0.0.1:${server.address().port}` };
  const input = JSON.stringify(payload('export PASSWORD=first"second third"'));
  for (let i = 0; i < 3; i++) {
    await invoke(input, env);
    await waitFor(() => requests.length === i + 1);
  }
  assert.equal(seen, 3);
});

async function waitFor(predicate, timeoutMs = 3500) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < timeoutMs, "timed out waiting for worker");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("stalled endpoint does not delay the configured hook; delivery workers expire", async t => {
  let seen = 0, closed = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => { seen++; });
    res.on("close", () => { closed++; });
    // Never respond: each worker must close its own connection and exit.
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...FULL_ENV, TEAMVIBE_API_URL: `http://127.0.0.1:${server.address().port}` };
  const latencies = [];
  for (let i = 0; i < 3; i++) latencies.push(await invoke(JSON.stringify(payload("echo hi")), env));
  assert.ok(Math.max(...latencies) < 750, `hook latencies must stay below 750ms: ${latencies}`);
  await waitFor(() => seen === 3);
  await waitFor(() => closed === 3);
  assert.equal(seen, 3, "exactly one delivery attempt per invocation");
});

test("delivery worker process exits on network timeout and incomplete stdin", async t => {
  let seen = 0;
  const server = createServer(req => {
    req.resume();
    req.on("end", () => { seen++; });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...FULL_ENV, TEAMVIBE_API_URL: `http://127.0.0.1:${server.address().port}` };
  const workerCommand = 'node "$CLAUDE_CONFIG_DIR/hooks/lib/bash-telemetry-worker.mjs"';
  const event = { eventType: "bash.command", channelId: "ch-1", metadata: {
    command: "echo hi", cwd: "/tmp/project", exitCode: 0, invokedAt: INVOKED_AT,
  } };
  assert.ok(await invoke(JSON.stringify(event), env, false, workerCommand) < 3500);
  assert.equal(seen, 1);
  assert.ok(await invoke("{", env, true, workerCommand) < 3500);
});
