#!/usr/bin/env node
/**
 * PostToolUse Bash telemetry. Read tool-call JSON from stdin, emit a redacted
 * bash.command event through a detached worker, and exit 0 silently. The parent
 * waits only for bounded stdin and a local pipe write, never network I/O.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareBashTelemetryHook } from "./lib/bash-telemetry-core.mjs";
import { acquireWorkerSlot, assignWorkerSlot, releaseWorkerSlot } from "./lib/bash-telemetry-slots.mjs";

const MAX_INPUT_BYTES = 256 * 1024;
const receivedAt = new Date().toISOString();
const deadline = setTimeout(() => process.exit(0), 2500);

async function main() {
  let lease, worker;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) return;
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const { event } = prepareBashTelemetryHook(payload, process.env, receivedAt);
    if (!event) return;
    lease = acquireWorkerSlot();
    if (!lease) return; // Optional telemetry drops immediately when saturated.
    worker = spawn(process.execPath, [fileURLToPath(new URL("./lib/bash-telemetry-worker.mjs", import.meta.url))], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (worker.pid) assignWorkerSlot(lease, worker.pid);
    worker.on("error", () => releaseWorkerSlot(lease));
    worker.unref();
    // Keep secret-bearing input out of argv and detach stdout/stderr so the
    // caller's pipes close as soon as this parent exits. Flush only the local
    // pipe before exiting; the worker owns its network and hard-exit timers.
    await new Promise(resolve => {
      worker.on("error", resolve);
      worker.stdin.on("error", resolve);
      worker.stdin.end(JSON.stringify(event), resolve);
    });
  } catch {
    // Malformed input, redaction failure, and network errors all fail open.
  } finally {
    // Successful workers keep their slots until a later caller observes their
    // PID has exited. Failed spawns never consume capacity.
    if (!worker?.pid) releaseWorkerSlot(lease);
    clearTimeout(deadline);
    process.exit(0);
  }
}

main();
