#!/usr/bin/env npx tsx
/**
 * Append a short-term memory note to memory/TODAY.md.
 *
 * Write only information worth remembering later: facts, findings, preferences,
 * and non-obvious context; event records and session state belong in their originating systems.
 * For important items that need tracking, use mem-write.ts instead.
 *
 * Usage:
 *   npx tsx log-write.ts "project: staging database resets every Sunday"
 *   npx tsx log-write.ts "finding: deploy requires SSO login first"
 *
 * Output:
 *   Logged to memory/TODAY.md
 */

import * as fs from "fs";
import { brainPath } from "./lib/brain-root.js";
import { computeRollover, todayMdCapMessage } from "./lib/today-md-core.js";

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
  const content = process.argv.slice(2).join(" ").trim();

  if (!content) {
    console.error('Usage: npx tsx log-write.ts "category: detail"');
    console.error("");
    console.error("Examples:");
    console.error('  npx tsx log-write.ts "project: staging database resets every Sunday"');
    console.error('  npx tsx log-write.ts "finding: deploy requires SSO login first"');
    process.exit(1);
  }

  if (fs.existsSync(TODAY_PATH)) {
    const message = todayMdCapMessage(fs.statSync(TODAY_PATH).size, process.env.TODAY_MD_MAX_BYTES);
    if (message) {
      console.error(message);
      process.exitCode = 2;
      return;
    }
  }

  ensureToday();

  const timestamp = new Date().toTimeString().slice(0, 5);
  fs.appendFileSync(TODAY_PATH, `- [${timestamp}] ${content}\n`);

  console.log(`Logged to ${TODAY_PATH}`);
}

main();
