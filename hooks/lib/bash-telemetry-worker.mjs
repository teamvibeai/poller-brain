#!/usr/bin/env node
// Private delivery worker: no output/retries; hard lifetime prevents lingering
// workers even if stdin, DNS, fetch, or socket cleanup stalls. Never shell eval.
import { deliverBashTelemetryEvent } from "./bash-telemetry-core.mjs";

const deadline = setTimeout(() => process.exit(0), 2500);

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) process.exit(0);
    chunks.push(chunk);
  }
  const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await deliverBashTelemetryEvent(event, process.env, fetch);
} catch {
  // Fail open without exposing command data or credentials.
} finally {
  clearTimeout(deadline);
  process.exit(0);
}
