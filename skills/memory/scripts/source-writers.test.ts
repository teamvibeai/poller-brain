import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let failed = 0;
for (const writer of ["log-write", "mem-write"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${writer}-source-`));
  fs.mkdirSync(path.join(root, "memory"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
  const today = path.join(root, "memory/TODAY.md");
  const registry = path.join(root, "memory/MEM_REGISTRY.md");
  const run = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv,
    fileURLToPath(new URL(`./${writer}.ts`, import.meta.url)), ...args], {
    env: { ...process.env, BRAIN_ROOT: root }, encoding: "utf8",
  });
  const snapshot = () => [today, registry].map(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const test = (name: string, body: () => void) => {
    try { body(); console.log(`PASS ${writer}: ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${writer}: ${name}: ${e}`); }
  };
  try {
    test("invalid and empty calls do not create files", () => {
      for (const args of [[], [" "], ["--source=maintenance"], ["--source=user-session"], ["--source=invalid", "text"],
        ["--source", "user-session", "text"], ["--source=maintenance", "--source=user-session", "text"]]) {
        const before = snapshot();
        const rejected = run(...args);
        assert.notEqual(rejected.status, 0, JSON.stringify(args));
        assert(!rejected.stderr.includes("MEM_ID="), "reject before allocating a MEM identity");
        assert.deepEqual(snapshot(), before);
      }
    });
    // Clear any files a broken baseline created in the negative case.
    for (const file of [today, registry]) fs.rmSync(file, { force: true });
    test("default and explicit sources survive rollover", () => {
      fs.writeFileSync(today, "# 2000-01-01\n\n- [12:34] [user] old entry\n");
      for (const [args, tag, text] of [
        [["default"], "maint", "default"],
        [["--source=maintenance", "scheduled"], "maint", "scheduled"],
        [["human", "--source=user-session"], "user", "human"],
      ] as const) {
        const result = run(...args);
        assert.equal(result.status, 0, result.stderr);
        assert.match(fs.readFileSync(today, "utf8"), new RegExp(`\\] \\[${tag}\\] ${text}\\n`));
      }
      const saved = fs.readFileSync(today, "utf8");
      assert(saved.startsWith("# 2000-01-01\n\n- [12:34] [user] old entry\n"));
      assert.equal((saved.match(/^# /gm) ?? []).length, 2);
      const before = snapshot();
      assert.notEqual(run("--source=typo", "text").status, 0);
      assert.deepEqual(snapshot(), before, "invalid calls cannot even roll over");
    });
    if (writer === "mem-write") test("user MEM retry, both partial halves, legacy compatibility and source conflicts", () => {
      const first = run("--source=user-session", "memo\ncontinuation");
      assert.equal(first.status, 0, first.stderr);
      const id = first.stderr.match(/^MEM_ID=(.+)$/m)?.[1];
      assert(id?.match(/^MEM-\d{4}-\d{2}-\d{2}-\d{6}-[a-f0-9-]{36}$/));
      const saved = snapshot();
      for (const args of [["--id", id, "--source=user-session", "memo\ncontinuation"],
        ["--source=user-session", "--id", id, "memo\ncontinuation"]]) {
        assert.equal(run(...args).status, 0);
        assert.deepEqual(snapshot(), saved);
      }
      assert.equal(run("--id", id, "--source=maintenance", "memo\ncontinuation").status, 3);
      assert.deepEqual(snapshot(), saved);
      fs.writeFileSync(registry, "");
      assert.equal(run("--id", id, "--source=user-session", "memo\ncontinuation").status, 0);
      assert.equal(snapshot()[0], saved[0]);
      fs.writeFileSync(today, "# 2000-01-01\n\n");
      const registryOnly = snapshot()[1];
      assert.equal(run("--id", id, "--source=user-session", "memo\ncontinuation").status, 0);
      assert.equal(snapshot()[1], registryOnly);
      assert(fs.readFileSync(today, "utf8").includes(`[${id}] [user] memo\ncontinuation`));
      fs.writeFileSync(today, `# 2000-01-01\n\n- [${id}] memo\ncontinuation\n`);
      const legacy = snapshot();
      assert.equal(run("--id", id, "memo\ncontinuation").status, 0);
      assert.deepEqual(snapshot(), legacy, "legacy retries leave unknown provenance intact");
      for (const args of [["--id", id, "--source=user-session"], ["--id", "MEM-1", "--source=user-session", "text"]]) {
        assert.notEqual(run(...args).status, 0);
        assert.deepEqual(snapshot(), legacy);
      }
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (failed) process.exitCode = 1;
