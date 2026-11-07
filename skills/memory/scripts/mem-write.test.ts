#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for dated writes, retries, and legacy scan behaviour.
 *
 * Targets the 2026-06-08 incident class: a silent over-match on a prose
 * mention of a MEM key (e.g. "...covered by MEM-78 above...") inflating the
 * counter past the next real canonical key.
 *
 * Run: npx tsx skills/memory/scripts/mem-write.test.ts
 * Exits non-zero if any assertion fails.
 */

import { getNextKeyFromContents } from "./lib/mem-write-core.js";
import * as core from "./lib/mem-write-core.js";
import * as ids from "./lib/mem-id.js";
import { strict as check } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { computeRollover } from "./lib/today-md-core.js";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    failed++;
    return;
  }
  passed++;
}

// Legacy scan behaviour (retained for other callers).

// --- prose mention must NOT move the counter --------------------------------
{
  const today = `# 2026-06-08

- [09:00] review: this incident traces back to MEM-78 and a related fix.
- [MEM-3] deploy: staging vyžaduje SSO login
`;
  const key = getNextKeyFromContents("", "", today);
  assert(
    key === 4,
    `prose mention of MEM-78 must not count — expected next key 4, got ${key}`
  );
}

// --- colon-variant canonical row IS counted (format drift tolerance) -------
{
  const today = `# 2026-06-09

- [MEM-3] deploy: staging vyžaduje SSO login
- [MEM-5]: komunikace, mužský rod
`;
  const key = getNextKeyFromContents("", "", today);
  assert(
    key === 6,
    `colon-variant canonical row must be counted — expected next key 6, got ${key}`
  );
}

// --- registry pipe-table rows are scanned regardless of TODAY.md state -----
{
  const registry = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-9 | ACTIVE | 2026-06-01 | — | some entry |
`;
  const key = getNextKeyFromContents(registry, "", "");
  assert(
    key === 10,
    `registry table row must be scanned — expected next key 10, got ${key}`
  );
}

// --- archive rows (REMOVED, relocated out of the live registry) still count -
{
  const registry = `| MEM-4 | ACTIVE | 2026-06-01 | — | still live |\n`;
  const archive = `| MEM-12 | REMOVED | 2026-05-01 | 2026-05-25 | superseded |\n`;
  const key = getNextKeyFromContents(registry, archive, "");
  assert(
    key === 13,
    `archived key must not be reused — expected next key 13, got ${key}`
  );
}

// --- the max across all three sources wins ---------------------------------
{
  const registry = `| MEM-5 | ACTIVE | 2026-06-01 | — | x |\n`;
  const archive = `| MEM-2 | REMOVED | 2026-05-01 | 2026-05-25 | y |\n`;
  const today = `- [MEM-20] deploy: z\n`;
  const key = getNextKeyFromContents(registry, archive, today);
  assert(key === 21, `overall max must win — expected next key 21, got ${key}`);
}

// --- all-empty inputs (fresh brain) start at 1 -----------------------------
{
  const key = getNextKeyFromContents("", "", "");
  assert(key === 1, `fresh brain must start at key 1, got ${key}`);
}

// --- mem-write.ts must roll over a stale TODAY.md header too (poller-brain#267:
// mem-write.ts historically only handled the file-missing case, never the
// stale-header case that log-write.ts already covers via the same function) --
{
  const content = "# 2026-07-28\n\n- [MEM-3] deploy: staging vyžaduje SSO login\n";
  const action = computeRollover(content, "2026-07-29");
  assert(
    action.kind === "append-header",
    "mem-write.ts's ensureToday must roll a stale header on a new UTC day"
  );
  assert(
    action.textToWrite === "\n# 2026-07-29\n\n",
    "rollover must append a fresh dated section, not rewrite history"
  );
}

// --- same-day mem-write.ts call must not duplicate the header --------------
{
  const content = "# 2026-07-29\n\n- [MEM-3] deploy: staging vyžaduje SSO login\n";
  const action = computeRollover(content, "2026-07-29");
  assert(action.kind === "none", "same-day mem-write.ts call must be a no-op");
}

// Mixed sources: dated IDs never advance the numeric allocator, even in stubs.
const DATED_A = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DATED_B = "MEM-2026-11-07-203001-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";

assert(getNextKeyFromContents(`| MEM-9 | ACTIVE | x |\n| ${DATED_A} | ACTIVE | x |`, "", "") === 10,
  "dated registry rows do not inflate the legacy maximum");
assert(getNextKeyFromContents("MEM-9", `| ${DATED_B} | REMOVED | x |`, "") === 10,
  "dated archive rows do not inflate the legacy maximum");
assert(getNextKeyFromContents("MEM-9", "", `- [${DATED_A}] x\n- [${DATED_B}:obsolete] y\n`) === 10,
  "dated canonical TODAY rows do not inflate the legacy maximum");
assert(getNextKeyFromContents(`Keys: ${DATED_A}, ${DATED_B}`, DATED_A, `- [${DATED_B}] x\n`) === 1,
  "dated-only sources leave next numeric key at one");

// PR 2 acceptance cases: a–h use the core without subprocesses.
let acceptancePassed = 0;
let acceptanceFailed = 0;
function acceptance(name: string, run: () => void): void {
  try { run(); acceptancePassed++; }
  catch (error) { acceptanceFailed++; console.error(`FAIL PR2 ${name}: ${error}`); }
}
const clock = new Date("2026-11-08T01:02:03.456+05:30");
const content = "deploy: staging vyžaduje SSO login";
const header5 = "| Key | Status | Created | Obsoleted | Description |\n|---|---|---|---|---|\n";
const header4 = "| Key | Status | Created | Description |\n|---|---|---|---|\n";
// Namespace access lets these new acceptance cases report missing exports on d0ac283.
const plan = (input: { today: string; registry: string; id: string; content: string }) => {
  check.equal(typeof core.planMemWrite, "function", "pure write planner is exported");
  return core.planMemWrite(input);
};
function apply(today: string, registry: string, id = DATED_A, text = content) {
  const result = plan({ today, registry, id, content: text });
  check.equal(result.kind, "ready");
  if (result.kind !== "ready") throw new Error("expected write plan");
  return { today: today + result.todayAppend, registry: registry + result.registryAppend, result };
}
acceptance("a default dated identity and injected UTC clock", () => {
  const id = ids.newMemId(clock);
  check(ids.isMemId(id));
  check.deepEqual(ids.parseMemId(id), { kind: "dated", date: "2026-11-07", time: "193203", uuid: id.slice(22) });
  const written = apply("", header5, id);
  check.equal(written.result.todayAppend, `- [${id}] ${content}\n`);
  check.equal(written.result.registryAppend, `| ${id} | ACTIVE | 2026-11-07 | — | ${content} |\n`);
});
acceptance("b identical content in separate requests has separate IDs", () => {
  const first = ids.newMemId(clock);
  const second = ids.newMemId(clock);
  check.notEqual(first, second);
  const one = apply("", header5, first);
  const two = apply(one.today, one.registry, second);
  check.equal(two.today.split(content).length - 1, 2);
  check.equal(two.registry.split(content).length - 1, 2);
});
acceptance("c completed retry is a byte-identical no-op", () => {
  const first = apply("", header5);
  const retry = apply(first.today, first.registry);
  check.equal(retry.result.todayAppend, "");
  check.equal(retry.result.registryAppend, "");
  check.equal(retry.today, first.today);
  check.equal(retry.registry, first.registry);
  // Presence is any bracketed occurrence in TODAY; registry keys are exact cells.
  const inline = apply(`prefix [${DATED_A}] ${content}\n`, first.registry);
  check.equal(inline.result.todayAppend, "");
});
acceptance("d either partial write completes only its missing half", () => {
  const full = apply("", header5);
  const todayOnly = apply(full.today, header5);
  check.equal(todayOnly.today, full.today);
  check.equal(todayOnly.registry, full.registry);
  const registryOnly = apply("", full.registry);
  check.equal(registryOnly.today, full.today);
  check.equal(registryOnly.registry, full.registry);
});
acceptance("e conflicting content rejects both appends", () => {
  const full = apply("", header5);
  for (const state of [full, { today: full.today, registry: header5 }, { today: "", registry: full.registry }]) {
    const snapshot = JSON.stringify(state);
    check.deepEqual(plan({ ...state, id: DATED_A, content: "different" }), {
      kind: "error", code: 3, message: `MEM id ${DATED_A} already used with different content`,
    });
    check.equal(JSON.stringify(state), snapshot);
  }
  check.equal(plan({ today: full.today, registry: full.registry + `| ${DATED_A} | ACTIVE | x | — | conflicting duplicate |\n`, id: DATED_A, content }).kind, "error");
  check.equal(plan({ today: `- [${DATED_A}] ${content} \n`, registry: full.registry, id: DATED_A, content }).kind, "error");
});
acceptance("f invalid and legacy retry IDs reject without writes", () => {
  const state = { today: "# old\n", registry: header5 };
  const snapshot = JSON.stringify(state);
  for (const id of ["MEM-12", "garbage", "", DATED_A + "\n", DATED_A + ":obsolete"]) {
    const result = plan({ ...state, id, content });
    check.equal(result.kind, "error");
    if (result.kind === "error") check.equal(result.code, 2);
    check.equal(JSON.stringify(state), snapshot);
  }
});
acceptance("g legacy rows and archive stub remain byte-identical", () => {
  const legacyToday = Array.from({ length: 900 }, (_, i) => `- [MEM-${i + 1}] old ${i + 1}\n`).join("");
  const stub = "> 📦 1 REMOVED key archived: MEM-901 (MEM_REGISTRY_ARCHIVE.md)\n";
  const legacyRegistry = header5 + Array.from({ length: 900 }, (_, i) => `| MEM-${i + 1} | ACTIVE | 2026-01-01 | — | old ${i + 1} |\n`).join("") + stub;
  const id = ids.newMemId(clock);
  const written = apply(legacyToday, legacyRegistry, id);
  check.equal(written.today.slice(0, legacyToday.length), legacyToday);
  check.equal(written.registry.slice(0, legacyRegistry.length), legacyRegistry);
  check(written.result.todayAppend.includes(`[${id}]`));
  check(written.result.registryAppend.includes(`| ${id} |`));
  check.equal(getNextKeyFromContents(written.registry, "MEM-902", written.today), 903);
});
acceptance("h four/five-column rows, escaping, and exact registry keys", () => {
  const text = "pipes: a | b\nnext line\r\nlast";
  for (const [header, middle] of [[header4, ""], [header5, "— | "]]) {
    const full = apply("", header, DATED_A, text);
    check.equal(full.result.registryAppend, `| ${DATED_A} | ACTIVE | 2026-11-07 | ${middle}pipes: a \\| b next line last |\n`);
    const retry = apply(full.today, full.registry, DATED_A, text);
    check.equal(retry.today, full.today);
    check.equal(retry.registry, full.registry);
    check.equal(plan({ today: "", registry: full.registry, id: DATED_A, content: "pipes: changed" }).kind, "error");
  }
  for (const line of [`| ${DATED_A}0 | ACTIVE | x | — | other |\n`, `| MEM-12 | ACTIVE | x | — | mentions ${DATED_A} |\n`]) {
    check.notEqual(apply("", header5 + line).result.registryAppend, "");
  }
  const list = "memo with a list\n- [item] preserve this line\n# 2026-01-01\nend";
  const multiline = apply("", header5, DATED_A, list);
  check.equal(apply(multiline.today, multiline.registry, DATED_A, list).today, multiline.today);
  check.equal(apply(multiline.today, header5, DATED_A, list).registry, multiline.registry);
  check.equal(plan({ today: `- [${DATED_A}] first\nsecond\n`, registry: header5, id: DATED_A, content: "first" }).kind, "error");
});

// One CLI integration case covers wiring, pre-write stderr order, recovery, and exit codes.
acceptance("CLI wiring", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-write-test-"));
  const memory = path.join(root, "memory");
  fs.mkdirSync(memory);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
  const todayPath = path.join(memory, "TODAY.md");
  const registryPath = path.join(memory, "MEM_REGISTRY.md");
  const preload = path.join(root, "observe.cjs");
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    for (const method of ['writeFileSync', 'appendFileSync']) {
      const original = fs[method];
      fs[method] = function(file, ...args) {
        if (String(file).startsWith(process.env.BRAIN_ROOT + path.sep + 'memory' + path.sep)) {
          process.stderr.write('FILE_WRITE=' + path.basename(file) + '\\n');
          if (method === 'appendFileSync' && path.basename(file) === 'MEM_REGISTRY.md' && fs.existsSync(path.join(process.env.BRAIN_ROOT, 'fail-registry'))) {
            throw new Error('simulated registry append failure');
          }
        }
        return original.call(this, file, ...args);
      };
    }
    require('node:module').syncBuiltinESMExports();
  `);
  const cli = fileURLToPath(new URL("./mem-write.ts", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv, "--require", preload, cli, ...args], {
    env: { ...process.env, BRAIN_ROOT: root }, encoding: "utf8",
  });
  const snapshot = () => [todayPath, registryPath].map((p) => fs.readFileSync(p, "utf8"));
  try {
    for (const id of ["MEM-12", "garbage"]) {
      const invalid = run("--id", id, content);
      check.equal(invalid.status, 2);
      check.equal(invalid.stderr.trim().split("\n").length, 1);
      check(!fs.existsSync(todayPath) && !fs.existsSync(registryPath));
    }
    const first = run(content);
    check.equal(first.status, 0, first.stderr);
    const id = first.stderr.match(/^MEM_ID=(.+)$/m)?.[1];
    check(id && ids.isMemId(id) && ids.parseMemId(id)?.kind === "dated", first.stderr);
    check(first.stderr.startsWith(`MEM_ID=${id}\nFILE_WRITE=`), first.stderr);
    check(first.stdout.startsWith(`Written [${id}] to `));
    const saved = snapshot();
    check(saved.every((text) => text.includes(id)));
    const retry = run("--id", id, content);
    check.equal(retry.status, 0);
    check.equal(retry.stdout, `Already written [${id}]\n`);
    check.equal(retry.stderr, "");
    check.deepEqual(snapshot(), saved);
    for (const [args, status, message] of [
      [["--id", id, "different"], 3, `MEM id ${id} already used with different content`],
      [["--id", "MEM-12", content], 2, null],
      [["--id", "garbage", content], 2, null],
    ] as const) {
      const result = run(...args);
      check.equal(result.status, status);
      check.equal(result.stdout, "");
      check.equal(result.stderr.trim().split("\n").length, 1);
      if (message) check.equal(result.stderr, message + "\n");
      check.deepEqual(snapshot(), saved);
    }
    // A retry on a later day must not append even a rollover header.
    fs.writeFileSync(todayPath, saved[0].replace(/^# \d{4}-\d{2}-\d{2}/, "# 2000-01-01"));
    const stale = snapshot();
    check.equal(run("--id", id, content).stdout, `Already written [${id}]\n`);
    check.deepEqual(snapshot(), stale);
    // Exercise both real partial-write paths and an actual failed first append.
    fs.writeFileSync(registryPath, header5);
    check.equal(run("--id", id, content).status, 0);
    check.equal(fs.readFileSync(todayPath, "utf8"), stale[0]);
    fs.writeFileSync(todayPath, "# 2000-01-01\n\n");
    const registryOnly = fs.readFileSync(registryPath, "utf8");
    check.equal(run("--id", id, content).status, 0);
    check.equal(fs.readFileSync(registryPath, "utf8"), registryOnly);
    const failureSwitch = path.join(root, "fail-registry");
    fs.writeFileSync(failureSwitch, "fail the second append");
    const failure = run("new memo after failure");
    check.notEqual(failure.status, 0);
    const failedId = failure.stderr.match(/^MEM_ID=(.+)$/m)?.[1];
    check(failedId && ids.isMemId(failedId), failure.stderr);
    check(fs.readFileSync(todayPath, "utf8").includes(`[${failedId}] new memo after failure`));
    check(!fs.readFileSync(registryPath, "utf8").includes(failedId));
    const partialToday = fs.readFileSync(todayPath, "utf8");
    fs.unlinkSync(failureSwitch);
    check.equal(run("--id", failedId, "new memo after failure").status, 0);
    check.equal(fs.readFileSync(todayPath, "utf8"), partialToday);
    const allocator = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(new URL("./mem-id-new.ts", import.meta.url))], { cwd: root, encoding: "utf8" });
    check.equal(allocator.status, 0, allocator.stderr);
    check.equal(allocator.stderr, "");
    check(ids.isMemId(allocator.stdout.trim()));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
// Reviewer content-boundary-cli.py, ported with checkbox and real-row pins.
function retryAfterFollowingLine(following: string, status: 0 | 3): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-write-boundary-"));
  const memory = path.join(root, "memory");
  fs.mkdirSync(memory);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
  const todayPath = path.join(memory, "TODAY.md");
  const registryPath = path.join(memory, "MEM_REGISTRY.md");
  const id = "MEM-2026-11-07-123456-11111111-2222-4333-8444-555555555555";
  const text = "deploy checklist:";
  const snapshot = () => [todayPath, registryPath].map((file) => fs.readFileSync(file));
  try {
    fs.writeFileSync(todayPath, `# 2026-11-07\n\n- [${id}] ${text}\n${following}\n`);
    fs.writeFileSync(registryPath, header5);
    const saved = snapshot();
    const result = spawnSync(process.execPath, [...process.execArgv,
      fileURLToPath(new URL("./mem-write.ts", import.meta.url)), "--id", id, text], {
      env: { ...process.env, BRAIN_ROOT: root }, encoding: "utf8",
    });
    check.equal(result.status, status, `${following}: ${result.stderr}`);
    if (status === 3) {
      check.equal(result.stdout, "");
      check.equal(result.stderr, `MEM id ${id} already used with different content\n`);
      check.deepEqual(snapshot(), saved, "conflicting retry leaves both files byte-identical");
    } else {
      check.equal(result.stderr, "");
      check(result.stdout.startsWith(`Written [${id}] to `));
      check.deepEqual(snapshot(), [saved[0], Buffer.from(header5 +
        `| ${id} | ACTIVE | 2026-11-07 | — | ${text} |\n`)], "only the missing registry row is appended");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
acceptance("o CLI rejects a prefix before a bracketed content item", () => {
  retryAfterFollowingLine("- [item] require SSO", 3);
});
acceptance("p CLI rejects a prefix before a checkbox continuation", () => {
  retryAfterFollowingLine("- [ ] todo", 3);
});
acceptance("q CLI completes partial retries before writer-produced boundaries", () => {
  for (const following of [
    "- [12:34] next log entry",
    "# 2026-11-08",
    "- [MEM-12] legacy memo",
    `- [${DATED_B}] dated memo`,
    "- [REMEMBER] remembered memo",
    "- 12:34 — memory consolidation started",
  ]) retryAfterFollowingLine("\n" + following, 0);
});
console.log(`PR2 acceptance: ${acceptancePassed} passed, ${acceptanceFailed} failed (a–h + CLI + o–q)`);
console.log(`${passed} assertions passed, ${failed} failed`);
if (failed || acceptanceFailed) process.exitCode = 1;
