import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const workflow = fs.readFileSync(fileURLToPath(new URL("../../../.github/workflows/tests.yml", import.meta.url)), "utf8");
assert.match(workflow, /for suite in [^\n]*\bdaily-log-cli\b[^\n]*; do/, "CI must execute the daily-log CLI suite");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-log-cli-"));
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const run = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv,
  fileURLToPath(new URL("./daily-log.ts", import.meta.url)), ...args], {
  env: { ...process.env, BRAIN_ROOT: root }, encoding: "utf8",
});
const json = (...args: string[]) => {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
try {
  fs.mkdirSync(path.join(root, "memory/daily"), { recursive: true });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  assert.equal(json("report", "2026-11-16").sessionDays, 0, "fresh repo is n/a");
  assert.equal(json("archive-plan", "2026-11-16", "13:00").today,
    "# 2026-11-16\n\n- [13:00][maint] memory consolidation started\n");
  const dates = [
    ["2026-11-09T23:30:00-02:00", "chore: [user] text is not provenance"], // Nov 10 UTC, included
    ["2026-11-17T00:30:00+02:00", "human work"], // Nov 16 UTC, included
    ["2026-11-16T20:00:00Z", "chore: same day"], // deduplicated
    ["2026-11-10T00:30:00+02:00", "before window"], // Nov 9 UTC, excluded
    ["2026-11-17T00:00:00Z", "after window"], // excluded
  ];
  for (const [date, subject] of dates) {
    fs.writeFileSync(path.join(root, "activity.txt"), date);
    git("add", "activity.txt");
    // Committer timestamps deliberately differ; the established author-day basis wins.
    const result = spawnSync("git", ["commit", "--allow-empty", "-qm", subject], { cwd: root, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: "2026-11-18T12:00:00Z" },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const backfill = json("backfill-plan", "2026-11-10");
  assert.equal(backfill.path, "memory/daily/2026-11-10.md");
  assert.match(backfill.content, /\[unknown\] \(backfilled from git\) — chore: \[user\] text/);
  fs.writeFileSync(path.join(root, backfill.path), backfill.content);
  const user = "# 2026-11-16\n\n- [12:00][user] requested chore\n- [12:30][maint] routine\n";
  fs.writeFileSync(path.join(root, "memory/daily/2026-11-16.md"), user);
  fs.writeFileSync(path.join(root, "memory/TODAY.md"), user);
  const before = git("status", "--short");
  const report = json("report", "2026-11-16");
  assert.equal(report.sessionDays, 2);
  assert.equal(report.loggedSessionDays, 2);
  assert.equal(report.userTaggedSessionDays, 1);
  assert.equal(report.unknownSessionDays, 1);
  assert.equal(report.provenanceCompleteness, 0.5);
  assert.equal(report.coverageRatio, 1);
  assert.equal(json("archive-plan", "2026-11-16", "13:00").daily["2026-11-16"], user + "\n" + user);
  for (const args of [["report", "2026-02-30"], ["archive-plan", "2026-11-16", "99:99"], ["bogus"], ["report", "2026-11-16", "extra"]]) {
    assert.notEqual(run(...args).status, 0);
  }
  assert.equal(git("status", "--short"), before, "plans and reports are read-only");
  assert.equal(fs.readFileSync(path.join(root, "memory/TODAY.md"), "utf8"), user);
  console.log("daily-log-cli: UTC boundaries, fresh repo, read-only plans and report assertions passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
