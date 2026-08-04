#!/usr/bin/env npx tsx
/**
 * Append a log entry to memory/TODAY.md.
 *
 * Use this for routine session logs (events, triage, status updates).
 * For important items that need tracking, use mem-write.ts instead.
 *
 * Usage:
 *   npx tsx log-write.ts "heartbeat: klidný den, žádné pending issues"
 *   npx tsx log-write.ts "triage: 3 nové emaily, žádný urgentní"
 *
 * --source=maintenance|user-session (optional, default: maintenance):
 *   Pass --source=user-session when this session was triggered by a real
 *   Slack message from a human (not Scheduled/heartbeat) — see CLAUDE.md's
 *   Message Types section. Feeds an observe-only coverage metric
 *   (poller-brain#169); the default is fail-safe (undercounts rather than
 *   masks idle brains behind cron activity).
 *
 * Output:
 *   Logged to memory/TODAY.md
 */

import * as fs from "fs";
import { brainPath } from "./lib/brain-root.js";
import { computeRollover } from "./lib/log-write-core.js";
import { parseSourceFlag, sourceTag } from "./lib/source-flag.js";

const TODAY_PATH = brainPath("memory/TODAY.md");

// Rollover decision lives in lib/log-write-core.ts (fixture-tested — see
// log-write.test.ts) so the day-boundary branch can't silently regress
// (poller-brain#184).
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
  let parsed;
  try {
    parsed = parseSourceFlag(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { source, content } = parsed;

  if (!content) {
    console.error('Usage: npx tsx log-write.ts "category: detail" [--source=maintenance|user-session]');
    console.error("");
    console.error("Examples:");
    console.error('  npx tsx log-write.ts "heartbeat: klidný den"');
    console.error('  npx tsx log-write.ts "triage: 3 nové emaily, žádný urgentní"');
    console.error('  npx tsx log-write.ts --source=user-session "triage: reagoval jsem na Slack zprávu"');
    process.exit(1);
  }

  ensureToday();

  const timestamp = new Date().toTimeString().slice(0, 5);
  fs.appendFileSync(TODAY_PATH, `- [${timestamp}] ${sourceTag(source)} ${content}\n`);

  console.log(`Logged to ${TODAY_PATH}`);
}

main();
