#!/usr/bin/env node
/**
 * PostToolUse Bash telemetry. Read tool-call JSON from stdin, emit a redacted
 * bash.command event, and always exit 0 silently. No dependencies or shell eval.
 * The deadline covers stdin and network I/O; oversized input is skipped.
 */
import { runBashTelemetryHook } from "./lib/bash-telemetry-core.mjs";

const MAX_INPUT_BYTES = 256 * 1024;
const deadline = setTimeout(() => process.exit(0), 2500);

async function main() {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) return;
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    await runBashTelemetryHook(payload, process.env, fetch);
  } catch {
    // Malformed input, redaction failure, and network errors all fail open.
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}

main();
