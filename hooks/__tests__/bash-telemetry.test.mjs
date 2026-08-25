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
import { runBashTelemetryHook, MAX_COMMAND_LENGTH } from "../lib/bash-telemetry-core.mjs";

const FULL_ENV = {
  TEAMVIBE_API_URL: "https://api.example.com",
  TEAMVIBE_POLLER_TOKEN: "poller-token-123",
  TEAMVIBE_CHANNEL_ID: "ch-1",
};
const payload = command => ({ tool_name: "Bash", tool_input: { command } });
const neverFetch = () => assert.fail("fetch should not have been called");

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
test("POST contract includes only redacted command metadata", async () => {
  const result = await runBashTelemetryHook({ ...payload('export TOKEN=first"second third"'),
    tool_response: { stdout: "response-secret", stderr: "error-secret" },
  }, { ...FULL_ENV, TEAMVIBE_API_URL: FULL_ENV.TEAMVIBE_API_URL + "/" }, async (url, init) => {
    assert.equal(url, "https://api.example.com/events");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, {
      Authorization: "Bearer poller-token-123", "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(init.body), {
      eventType: "bash.command", channelId: "ch-1", metadata: { command: "export [REDACTED]" },
    });
    assert.ok(init.signal instanceof AbortSignal);
    return { ok: true, status: 200 };
  });
  assert.deepEqual(result, { posted: true, reason: "ok" });
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
function invoke(input, env = {}, leaveStdinOpen = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
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
      try { assert.deepEqual({ code, signal, stdout, stderr }, { code: 0, signal: null, stdout: "", stderr: "" }); resolve(); }
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
      assert.deepEqual(body, { eventType: "bash.command", channelId: "ch-1", metadata: { command: "export [REDACTED]" } });
      if (seen === 1) { res.writeHead(204); res.end(); }
      else if (seen === 2) { res.writeHead(500); res.end(); }
      // Third request intentionally never responds.
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...FULL_ENV, TEAMVIBE_API_URL: `http://127.0.0.1:${server.address().port}` };
  const input = JSON.stringify(payload('export PASSWORD=first"second third"'));
  for (let i = 0; i < 3; i++) await invoke(input, env);
  assert.equal(seen, 3);
});
