// Round-two disclosure and worker-resource regressions. Run with plain Node 22.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets } from "../lib/bash-telemetry-redact.mjs";
import { prepareBashTelemetryHook } from "../lib/bash-telemetry-core.mjs";
import { simpleCommands } from "../lib/shell-tokenizer.mjs";

const TOKEN = "tvp_ConfiguredCanarySecretValue";
const env = { TEAMVIBE_API_URL: "http://fixture.invalid", TEAMVIBE_POLLER_TOKEN: TOKEN,
  TEAMVIBE_CHANNEL_ID: "fixture-channel" };
const input = command => ({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp" });
const decode = command => simpleCommands(command, { allowEnvReferences: true, stripSudo: false })
  .flatMap(({ words }) => words).join(" ");

test("credential headers redact every scheme and the complete quoted/multiline value", () => {
  let checks = 0;
  for (const header of ["Authorization: Basic", "Authorization: token", "Authorization: CustomScheme",
    "Proxy-Authorization: Basic", "X-Api-Key:", "X-Service-Token:", "X-Service-Secret:", "Cookie:"]) {
    for (const value of ["CanaryHeaderSecret", "CanaryHeaderSecret trailingCanary", "CanaryHeaderSecret\ntrailingCanary"]) {
      for (const command of [`curl -H '${header} ${value}' https://example.invalid`, `${header} '${value}'`]) {
        const output = redactSecrets(command);
        assert.ok(!/Canary/.test(output), `${command}: ${output}`);
        checks++;
      }
    }
    for (const reference of ["$REF", "${REF}"]) {
      const command = `curl -H '${header} ${reference}'`;
      assert.equal(redactSecrets(command), command, "whole variable reference must survive");
      checks++;
    }
  }
  for (const command of [
    `curl -H'Authorization: Basic CanaryAttached'`,
    `curl --header='pRoXy-AuThOrIzAtIoN: Custom CanaryMixedCase'`,
    `curl -H 'X-Public: yes\nCookie: CanaryCookie; tail=trailingCanary'`,
    `curl -H 'Authorization: Basic $REF trailingCanary'`,
    `curl -H 'X-Api-Key: $REF-trailingCanary'`,
    `curl -H 'X-Secret: firstCanary' -H 'Cookie: trailingCanary'`,
  ]) {
    assert.ok(!/Canary/.test(redactSecrets(command)), command);
    checks++;
  }
  for (const command of [
    `Authorization: Basic "$REF"`, `Proxy-Authorization: CustomScheme ${"${REF}"}`,
    `X-Api-Key: "$REF"`, `Cookie: '${"${REF}"}'`,
    `curl -H'Authorization: Basic $REF' https://example.invalid`,
    `curl -H 'Accept: application/json'`,
    "echo " + "long-label-".repeat(6000),
  ]) {
    assert.equal(redactSecrets(command), command);
    checks++;
  }
  console.log(`header checks=${checks}`);
});

test("append/indexed assignments redact the complete value, including declaration forms", () => {
  let checks = 0;
  for (const prefix of ["", "export ", "declare ", "declare -a ", "local ", "readonly "]) {
    for (const assignment of ["PASSWORD+=", "TOKEN[0]=", "TOKEN[i]+=", "TOKEN[123]="]) {
      for (const value of ["CanaryAssignmentSecret", "'CanaryAssignmentSecret trailingCanary'", '"CanaryAssignmentSecret\ntrailingCanary"']) {
        const command = `${prefix}${assignment}${value}`;
        assert.ok(!/Canary/.test(redactSecrets(command)), command);
        checks++;
      }
      for (const reference of ["$REF", "${REF}"]) {
        const command = `${prefix}${assignment}${reference}`;
        assert.equal(redactSecrets(command), command);
        checks++;
      }
    }
  }
  for (const command of ["TOKEN[$(printf 0)]=CanaryUnsupported", "TOKEN=(CanaryUnsupported moreCanary)",
    "TOKEN[${INDEX:-0}]+=CanaryUnsupported", "TOKEN[1 + 2]='CanaryUnsupported moreCanary'",
    "declare -A TOKEN=([name]='CanaryUnsupported moreCanary')"]) {
    assert.ok(!/Canary/.test(redactSecrets(command)), command);
    checks++;
  }
  console.log(`assignment checks=${checks}`);
});

test("configured credentials are masked on decoded words, including substrings and cwd", () => {
  let checks = 0;
  for (const value of [TOKEN, "tvp_ConfiguredCanary'SecretValue'", String.raw`tvp_ConfiguredCanarySecret\Value`,
    '"tvp_Configured"CanarySecretValue', "prefix-tvp_ConfiguredCanary'SecretValue'-suffix"]) {
    for (const field of ["command", "cwd"]) {
      const payload = input(`echo ${value}`);
      if (field === "cwd") payload.cwd = `/tmp/${value}`;
      const { event } = prepareBashTelemetryHook(payload, env);
      assert.ok(event);
      assert.ok(!decode(event.metadata[field]).includes(TOKEN), `${field}: ${event.metadata[field]}`);
      assert.ok(!/ConfiguredCanary|SecretValue/.test(event.metadata[field]), "omit the entire matching word");
      checks++;
    }
  }
  console.log(`known-token checks=${checks}`);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 5000) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < ms, "deadline waiting for delivery/worker exit");
    await delay(10);
  }
}

test("stalled bursts cap workers at four; stale slots and spawn failures recover silently", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bash-telemetry-burst-"));
  const log = join(dir, "spawns.jsonl");
  const preload = join(dir, "inspect.mjs");
  writeFileSync(log, "");
  writeFileSync(preload, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
if (process.argv[1]?.endsWith('/hooks/bash-telemetry.mjs')) {
  const original = cp.spawn;
  cp.spawn = (executable, args, options) => {
    if (process.env.BURST_SPAWN_MODE === 'throw') throw new Error('fixture spawn failure');
    if (process.env.BURST_SPAWN_MODE === 'async-error') executable += '.nonexistent';
    const child = original(executable, args, options);
    if (child.pid) appendFileSync(process.env.BURST_LOG, JSON.stringify({pid: child.pid}) + '\\n');
    return child;
  };
  syncBuiltinESMExports();
}
`);
  const pids = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).pid);
  const alive = () => pids().filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  let requests = 0, stalled = true;
  const server = createServer((req, res) => {
    req.resume(); req.on("end", () => { requests++; if (!stalled) { res.writeHead(204); res.end(); } });
  });
  t.after(() => {
    server.closeAllConnections(); server.close();
    for (const pid of alive()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const childEnv = { PATH: process.env.PATH, TMPDIR: dir, BURST_LOG: log,
    NODE_OPTIONS: `--import ${pathToFileURL(preload)}`, ...env,
    TEAMVIBE_API_URL: `http://127.0.0.1:${server.address().port}` };
  const hook = fileURLToPath(new URL("../bash-telemetry.mjs", import.meta.url));
  let maxWorkers = 0;
  const sampler = setInterval(() => { maxWorkers = Math.max(maxWorkers, alive().length); }, 5);
  t.after(() => clearInterval(sampler));
  const latencies = [];
  async function invokeOne(i, extra = {}) {
    const start = Date.now();
    const child = spawn(process.execPath, [hook], { env: { ...childEnv, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    child.stdin.end(JSON.stringify(input(`echo burst-${i}`)));
    assert.deepEqual(await done, { code: 0, signal: null, stdout: "", stderr: "" });
    latencies.push(Date.now() - start);
  }

  // A recently dead parent could have orphaned a worker before PID handoff.
  // Fresh reservations stay occupied; aged reservations and abandoned staging
  // directories are reclaimed without waiting on the hook path.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  const root = join(dir, `teamvibe-bash-telemetry-${process.getuid?.() ?? "user"}`);
  const owner = `pending-${deadPid}-12345678-abcd`;
  for (let i = 0; i < 4; i++) {
    const slot = join(root, `slot-${i}`);
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, owner), "");
  }
  await invokeOne("fresh-pending");
  assert.equal(pids().length, 0);
  for (let i = 0; i < 4; i++) utimesSync(join(root, `slot-${i}`, owner), 0, 0);
  const abandoned = join(root, `claim-${deadPid}-12345678-abcd`);
  mkdirSync(abandoned);
  utimesSync(abandoned, 0, 0);
  for (const burst of ["sequential", "parallel"]) {
    const before = requests;
    if (burst === "sequential") {
      for (let i = 0; i < 30; i++) await invokeOne(i);
    } else {
      await Promise.all(Array.from({ length: 30 }, (_, i) => invokeOne(i)));
    }
    await until(() => alive().length === 0);
    assert.ok(maxWorkers <= 4, `maximum concurrent workers: ${maxWorkers}`);
    assert.ok(requests > before && requests < before + 30, `delivered ${requests - before}; saturation must drop events`);
    console.log(`${burst} burst: calls=30, posts=${requests - before}, maxWorkers=${maxWorkers}, remainingWorkers=0`);
  }
  assert.equal(existsSync(abandoned), false);
  assert.equal(requests, pids().length, "each admitted invocation sends exactly once");
  const before = requests;
  for (const mode of ["throw", "async-error"]) await invokeOne(mode, { BURST_SPAWN_MODE: mode });
  assert.equal(pids().length, before, "spawn failures must not start delivery workers");
  stalled = false;
  await invokeOne("recovery");
  await until(() => requests === before + 1 && alive().length === 0);
  assert.ok(Math.max(...latencies) < 750, `maximum hook latency: ${Math.max(...latencies)}ms`);
  console.log(`capacity recovery: calls=64, posts=${requests}, spawnFailures=2, freshPendingDrops=1, maxWorkers=${maxWorkers}, maxHookMs=${Math.max(...latencies)}, remainingWorkers=0`);
});
