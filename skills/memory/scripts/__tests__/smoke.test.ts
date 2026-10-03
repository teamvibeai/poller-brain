#!/usr/bin/env npx tsx
/**
 * Smoke tests for the memory write scripts (mem-write.ts, log-write.ts).
 *
 * Black-box: each case builds a throwaway brain dir (CLAUDE.md + memory/),
 * points the script at it via the BRAIN_ROOT escape hatch, runs it as a
 * subprocess, and asserts on the resulting files. No source import, no
 * refactor of the scripts, no test-runner dependency — just tsx + node:assert.
 *
 * Regression anchor: poller-brain#184. The MEM-7 → MEM-79 over-match incident
 * (2026-06-08) — a prose "MEM-N" mention wrongly bumping the counter — is
 * covered by the prose-vs-canonical case below.
 *
 * Run: bash skills/memory/scripts/__tests__/run.sh
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import assert from "node:assert";

const SCRIPTS = path.resolve(__dirname, "..");
const REGISTRY_HEADER =
  "# MEM Registry\n\n| Key | Status | Created | Obsoleted | Description |\n" +
  "|-----|--------|---------|-----------|-------------|\n";

function makeBrain(today: string, registry: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-smoke-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# test brain\n");
  fs.mkdirSync(path.join(dir, "memory"));
  fs.writeFileSync(path.join(dir, "memory", "TODAY.md"), today);
  fs.writeFileSync(path.join(dir, "memory", "MEM_REGISTRY.md"), registry);
  return dir;
}

function run(script: string, brain: string, arg: string) {
  const res = spawnSync("npx", ["tsx", path.join(SCRIPTS, script), arg], {
    env: { ...process.env, BRAIN_ROOT: brain },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`${script} exited ${res.status}: ${res.stderr || res.stdout}`);
  }
  return res;
}

const readToday = (brain: string) =>
  fs.readFileSync(path.join(brain, "memory", "TODAY.md"), "utf-8");
const readRegistry = (brain: string) =>
  fs.readFileSync(path.join(brain, "memory", "MEM_REGISTRY.md"), "utf-8");

let passed = 0;
const cases: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => cases.push([name, fn]);

// 1. Prose mention must NOT increment; canonical anchored row is the source of truth.
test("mem-write: prose MEM-78 ignored, canonical MEM-3 -> next is 4", () => {
  const brain = makeBrain(
    "# 2026-07-20\n\n- reviewed guard MEM-78 during PR review today\n- [MEM-3] deploy: staging needs SSO\n",
    REGISTRY_HEADER
  );
  run("mem-write.ts", brain, "test: nová položka");
  assert.match(readToday(brain), /- \[MEM-4\] test: nová položka/);
});

// 2. Colon drift tolerance: `- [MEM-5]:` counts as canonical.
test("mem-write: colon-variant canonical MEM-5 -> next is 6", () => {
  const brain = makeBrain(
    "# 2026-07-20\n\n- [MEM-5]: komunikace: vždy česky\n",
    REGISTRY_HEADER
  );
  run("mem-write.ts", brain, "test: colon drift");
  assert.match(readToday(brain), /- \[MEM-6\] test: colon drift/);
});

// 3. Registry max wins when higher than TODAY.
test("mem-write: registry MEM-9 + empty TODAY -> next is 10", () => {
  const brain = makeBrain(
    "# 2026-07-20\n\n",
    REGISTRY_HEADER + "| MEM-9 | ACTIVE | 2026-01-01 | — | seed |\n"
  );
  run("mem-write.ts", brain, "test: registry max");
  assert.match(readToday(brain), /- \[MEM-10\] test: registry max/);
  assert.match(readRegistry(brain), /\| MEM-10 \| ACTIVE \|/);
});

// 4. log-write appends a `- [HH:MM] ...` timestamped line.
test("log-write: appends - [HH:MM] line", () => {
  const brain = makeBrain("# 2026-07-20\n\n", REGISTRY_HEADER);
  run("log-write.ts", brain, "triage: klidný den");
  assert.match(readToday(brain), /^- \[\d{2}:\d{2}\] triage: klidný den$/m);
});

for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}
console.log(`\n${passed}/${cases.length} passed`);
process.exit(passed === cases.length ? 0 : 1);
