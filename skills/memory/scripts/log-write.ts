#!/usr/bin/env npx tsx
/**
 * Append a log entry to memory/TODAY.md.
 *
 * Use this for routine session logs (events, triage, status updates).
 * For important items that need tracking, use mem-write.ts instead.
 *
 * Usage:
 *   npx tsx log-write.ts --source=maintenance "heartbeat: klidný den, žádné pending issues"
 *   npx tsx log-write.ts --source=user-session "triage: 3 nové emaily, žádný urgentní"
 *
 * Output:
 *   Logged to memory/TODAY.md
 */

import * as fs from "fs";
import { parseSourceFlag, sourceTag } from "./lib/source-flag.js";
import { brainPath } from "./lib/brain-root.js";
import { computeRollover } from "./lib/today-md-core.js";

const TODAY_PATH = brainPath("memory/TODAY.md");

// Rollover decision lives in lib/today-md-core.ts (fixture-tested — see
// log-write.test.ts) so the day-boundary branch can't silently regress
// (poller-brain#184). Shared with mem-write.ts (poller-brain#267).
function ensureToday(): void {
  const today = new Date().toISOString().slice(0, 10);
  const existingContent = fs.existsSync(TODAY_PATH)
    ? fs.readFileSync(TODAY_PATH, "utf-8")
    : null;
  const action = computeRollover(existingContent, today);

  if (action.kind === "create") {
    fs.writeFileSync(TODAY_PATH, action.textToWrite);
  } else if (action.kind === "append-header") {
    fs.appendFileSync(TODAY_PATH, action.textToWrite);
  }
}

function main(): void {
  let parsed: ReturnType<typeof parseSourceFlag>;
  try { parsed = parseSourceFlag(process.argv.slice(2)); }
  catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }
  const { source, content } = parsed;

  if (!content) {
    console.error('Usage: npx tsx log-write.ts [--source=maintenance|user-session] "category: detail"');
    console.error("");
    console.error("Examples:");
    console.error('  npx tsx log-write.ts --source=maintenance "heartbeat: klidný den"');
    console.error('  npx tsx log-write.ts --source=user-session "triage: 3 nové emaily, žádný urgentní"');
    process.exit(1);
  }

  ensureToday();

  const timestamp = new Date().toTimeString().slice(0, 5);
  fs.appendFileSync(TODAY_PATH, `- [${timestamp}]${sourceTag(source)} ${content}\n`);

  console.log(`Logged to ${TODAY_PATH}`);
}

main();
