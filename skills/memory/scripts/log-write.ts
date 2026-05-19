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
 * Output:
 *   Logged to memory/TODAY.md
 */

import * as fs from "fs";
import * as path from "path";

const TODAY_PATH = "memory/TODAY.md";

function ensureToday(): void {
  const today = new Date().toISOString().slice(0, 10);

  if (!fs.existsSync(TODAY_PATH)) {
    fs.mkdirSync(path.dirname(TODAY_PATH), { recursive: true });
    fs.writeFileSync(TODAY_PATH, `# ${today}\n\n`);
    return;
  }

  // If TODAY.md exists but lacks today's date section, prepend one so entries are
  // filed under the correct date when consolidation archives the file to daily/.
  const content = fs.readFileSync(TODAY_PATH, "utf8");
  if (!content.includes(`# ${today}`)) {
    fs.writeFileSync(TODAY_PATH, `# ${today}\n\n` + content);
  }
}

function main(): void {
  const content = process.argv.slice(2).join(" ").trim();

  if (!content) {
    console.error('Usage: npx tsx log-write.ts "category: detail"');
    console.error("");
    console.error("Examples:");
    console.error('  npx tsx log-write.ts "heartbeat: klidný den"');
    console.error('  npx tsx log-write.ts "triage: 3 nové emaily, žádný urgentní"');
    process.exit(1);
  }

  ensureToday();

  const timestamp = new Date().toTimeString().slice(0, 5);
  fs.appendFileSync(TODAY_PATH, `- [${timestamp}] ${content}\n`);

  console.log(`Logged to ${TODAY_PATH}`);
}

main();
