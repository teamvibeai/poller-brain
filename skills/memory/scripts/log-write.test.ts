#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for log-write.ts date rollover and byte-size cap.
 *
 * Covers the day-boundary branch: a new day must start a fresh "# YYYY-MM-DD"
 * section, checked against the LAST header (not the first) so a same-day
 * call after an earlier rollover does not append a duplicate section.
 *
 * Run: npx tsx skills/memory/scripts/log-write.test.ts
 * Exits non-zero on the first failed assertion.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { computeRollover, todayMdCapMessage } from "./lib/today-md-core.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// --- missing file: create with today's header ------------------------------
{
  const action = computeRollover(null, "2026-07-29");
  assert(action.kind === "create", "missing file must create");
  assert(
    action.textToWrite === "# 2026-07-29\n\n",
    "create must write today's header"
  );
}

// --- same-day call: no rollover ---------------------------------------------
{
  const content = "# 2026-07-29\n\n- [09:00] some entry\n";
  const action = computeRollover(content, "2026-07-29");
  assert(action.kind === "none", "same-day call must be a no-op");
}

// --- new day: append a fresh header ------------------------------------------
{
  const content = "# 2026-07-28\n\n- [23:59] end of day entry\n";
  const action = computeRollover(content, "2026-07-29");
  assert(action.kind === "append-header", "new day must append a header");
  assert(
    action.textToWrite === "\n# 2026-07-29\n\n",
    "append must be a new section, leading blank line included"
  );
}

// --- multiple headers already present: only the LAST one matters -----------
{
  // Simulates a file that already rolled over earlier in the session; a
  // second same-day call must not re-append a duplicate section.
  const content =
    "# 2026-07-28\n\n- [23:00] entry\n\n# 2026-07-29\n\n- [00:05] entry\n";
  const action = computeRollover(content, "2026-07-29");
  assert(
    action.kind === "none",
    "must check the LAST header, not the first — no duplicate section"
  );
}

// --- invalid overrides fall back to the default, without coercing input -----
for (const value of [undefined, "", "0", "-1", "1.5", "abc", "15KB", "1e3", " 64 ", "Infinity", "9007199254740992"]) {
  assert(todayMdCapMessage(15359, value) === null, `invalid env ${value}: below default cap`);
  assert(todayMdCapMessage(15360, value)?.includes("NOT written") === true,
    `invalid env ${value}: at default cap`);
}
assert(todayMdCapMessage(63, "64") === null, "valid override permits below-cap size");
assert(todayMdCapMessage(64, "64")?.includes("NOT written") === true, "valid override refuses at cap");

// --- CLI guard runs before any append, including a stale date's rollover ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "log-write-test-"));
  fs.mkdirSync(path.join(root, "memory"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
  const todayPath = path.join(root, "memory/TODAY.md");
  const cli = fileURLToPath(new URL("./log-write.ts", import.meta.url));
  const note = "finding: DNS cache TTL is 2h";
  const run = (cap?: string) => spawnSync(process.execPath, [...process.execArgv, cli, note], {
    env: { ...process.env, BRAIN_ROOT: root, TODAY_MD_MAX_BYTES: cap ?? "" }, encoding: "utf8",
  });
  const fixture = (header: string, size: number) => {
    // Multibyte content ensures the guard measures bytes, not string length.
    const prefix = `# ${header}\n\né`;
    return Buffer.from(prefix + "x".repeat(size - Buffer.byteLength(prefix)));
  };
  try {
    const fresh = run();
    assert(fresh.status === 0, `missing file succeeds: ${fresh.stderr}`);
    assert(fs.readFileSync(todayPath, "utf8").includes(note), "fresh file contains the note");
    const today = new Date().toISOString().slice(0, 10);
    const below = fixture(today, 15359);
    fs.writeFileSync(todayPath, below);
    const success = run();
    assert(success.status === 0, `below cap succeeds: ${success.stderr}`);
    assert(fs.readFileSync(todayPath).subarray(0, below.length).equals(below), "below-cap append preserves existing bytes");
    assert(fs.readFileSync(todayPath, "utf8").includes(note), "below-cap append writes the note");

    for (const header of [today, "2000-01-01"]) {
      for (const size of [15360, 15361]) {
        const before = fixture(header, size);
        fs.writeFileSync(todayPath, before);
        const refused = run();
        assert(refused.status === 2, `${header} size ${size}: exits 2`);
        assert(refused.stderr.includes("NOT written"), "refusal explains entry was not written");
        assert(refused.stdout === "", "refusal does not report success");
        assert(fs.readFileSync(todayPath).equals(before), "refusal leaves file byte-identical, including stale header");
      }
    }
    const small = fixture(today, 64);
    fs.writeFileSync(todayPath, small);
    const overridden = run("64");
    assert(overridden.status === 2 && overridden.stderr.includes("NOT written"), "lower env override refuses at cap");
    assert(fs.readFileSync(todayPath).equals(small), "override refusal preserves bytes");
    const large = fixture("2000-01-01", 15360);
    fs.writeFileSync(todayPath, large);
    const raised = run("20000");
    assert(raised.status === 0, `higher env override allows write: ${raised.stderr}`);
    const written = fs.readFileSync(todayPath, "utf8");
    assert(written.startsWith(large.toString()) && written.includes(`\n# ${today}\n\n`) && written.includes(note),
      "below override cap preserves rollover and appends note");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log(`✅ all ${passed} assertions passed`);
