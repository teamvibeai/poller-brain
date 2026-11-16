#!/usr/bin/env npx tsx
/** Read-only archive/backfill plans and report aggregates for consolidation.
 * Usage: daily-log.ts archive-plan YYYY-MM-DD HH:MM
 *        daily-log.ts backfill-plan YYYY-MM-DD
 *        daily-log.ts report YYYY-MM-DD
 * Plans are stdout JSON, for review and the existing consolidation transaction;
 * this command never writes memory files or a daily JSON sidecar.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveBrainRoot } from "./lib/brain-root.js";
import { planTodayArchive, backfillDailyLog, dailyLogProvenance } from "./lib/daily-log-core.js";

try {
  const [mode, date, time, ...rest] = process.argv.slice(2);
  if (rest.length || !["archive-plan", "backfill-plan", "report"].includes(mode) || !date || (mode === "archive-plan" ? !time : time !== undefined)) {
    throw new Error("Usage: daily-log.ts archive-plan YYYY-MM-DD HH:MM | backfill-plan YYYY-MM-DD | report YYYY-MM-DD");
  }
  // Validate the date before reading Git or memory, using the shared UTC window.
  dailyLogProvenance({ end: date, sessionDays: [], daily: {} });
  const root = resolveBrainRoot();
  const read = (relative: string) => fs.existsSync(path.join(root, relative)) ? fs.readFileSync(path.join(root, relative), "utf8") : "";
  const dailyDir = path.join(root, "memory/daily");
  const daily = Object.fromEntries((fs.existsSync(dailyDir) ? fs.readdirSync(dailyDir) : [])
    .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map(name => [name.slice(0, 10), read(`memory/daily/${name}`)]));
  if (mode === "archive-plan") {
    console.log(JSON.stringify(planTodayArchive(read("memory/TODAY.md"), daily, date, time), null, 2));
  } else {
    // Author dates match the existing %as commit-day basis, normalized to UTC.
    // Filter by calendar dates in code: --since filters committer dates and
    // rolling durations, which would omit commits at the window's boundaries.
    const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root, encoding: "utf8" });
    if (head.status !== 0 && head.status !== 1) throw new Error(head.stderr || "Cannot inspect Git HEAD");
    const history = head.status === 1 ? "" : execFileSync("git", ["log", "--format=%aI %s", "--", "."], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const commits = history.trim().split("\n").filter(Boolean).map(line => {
      const split = line.indexOf(" ");
      return { day: new Date(line.slice(0, split)).toISOString().slice(0, 10), subject: line.slice(split + 1) };
    });
    const result = mode === "backfill-plan"
      ? { path: `memory/daily/${date}.md`, content: backfillDailyLog(date, commits.filter(c => c.day === date).map(c => c.subject)) }
      : dailyLogProvenance({ end: date, sessionDays: commits.map(c => c.day), daily });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
