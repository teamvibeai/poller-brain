// Run: node skills/brain-write/scripts/__tests__/brain-write.test.mjs
// Exercise the dependency-free CLI used by the tsx launcher, in disposable repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const script = fileURLToPath(new URL("../brain-write.mjs", import.meta.url));
const MAX_BYTES = 512 * 1024;

function fixture(t, git = true) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "brain");
  fs.mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  // Prove that channel CWD, rather than base-brain/memory environment, is used.
  env.CLAUDE_CONFIG_DIR = path.join(temporary, "base-brain");
  env.BRAIN_ROOT = env.CLAUDE_CONFIG_DIR;
  if (git) {
    const result = spawnSync("git", ["init", "--quiet", root], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const write = (relative, content = "original\n") => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return absolute;
  };
  const run = (args, input = "replacement\n", cwd = root) => spawnSync(process.execPath, [script, ...args], {
    cwd, env, input, encoding: "utf8", timeout: 10000,
  });
  return { temporary, root, write, run };
}

function success(result, summary) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, summary);
}

// Refusals must leave both the brain and outside fixtures unchanged, including
// empty directories and symlinks. Ignore git internals, which git itself owns.
function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      const relative = path.relative(root, absolute);
      if (stat.isSymbolicLink()) entries.push([relative, "link", fs.readlinkSync(absolute)]);
      else if (stat.isDirectory()) {
        entries.push([relative, "directory"]);
        visit(absolute);
      } else entries.push([relative, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
    }
  }
  visit(root);
  return entries;
}

function refuse(f, args, reason, input, cwd) {
  const before = snapshot(f.temporary);
  const result = f.run(args, input, cwd);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, reason);
  assert.deepEqual(snapshot(f.temporary), before, "refusal must not mutate any fixture");
}

for (const directory of ["skills", "commands", "agents"]) {
  test(`allows a write in .claude/${directory}`, (t) => {
    const f = fixture(t);
    const target = `.claude/${directory}/demo.md`;
    success(f.run([target], "# Demo\n"), new RegExp(`Created \\.claude/${directory}/demo\\.md \\(7 bytes\\)`));
    assert.equal(fs.readFileSync(path.join(f.root, target), "utf8"), "# Demo\n");
    assert.equal(fs.existsSync(path.join(f.root, ".git/index")), false, "does not stage or commit");
  });
}

test("creates nested parent directories", (t) => {
  const f = fixture(t);
  const target = ".claude/skills/new/deep/SKILL.md";
  success(f.run([target]), /Created/);
  assert.equal(fs.readFileSync(path.join(f.root, target), "utf8"), "replacement\n");
});

test("overwrites atomically and preserves executable mode", (t) => {
  const f = fixture(t);
  const target = ".claude/skills/demo/run.sh";
  const absolute = f.write(target);
  fs.chmodSync(absolute, 0o755);
  const originalInode = fs.statSync(absolute).ino;
  success(f.run([target], "new\n"), /Updated .*\(9 -> 4 bytes\)/);
  assert.equal(fs.readFileSync(absolute, "utf8"), "new\n");
  assert.notEqual(fs.statSync(absolute).ino, originalInode, "rename replaces the inode");
  assert.equal(fs.statSync(absolute).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(path.dirname(absolute)), ["run.sh"], "no temporary files remain");
});

test("reports unchanged content without replacing the file", (t) => {
  const f = fixture(t);
  const target = ".claude/commands/demo.md";
  const absolute = f.write(target);
  const inode = fs.statSync(absolute).ino;
  success(f.run([target], "original\n"), /Unchanged/);
  assert.equal(fs.statSync(absolute).ino, inode);
});

test("deletes a file while retaining its parent and sibling", (t) => {
  const f = fixture(t);
  const target = ".claude/agents/demo.md";
  const absolute = f.write(target);
  const sibling = f.write(".claude/agents/keep.md");
  success(f.run([target, "--delete"]), /Deleted .*\(9 bytes\)/);
  assert.equal(fs.existsSync(absolute), false);
  assert.equal(fs.readFileSync(sibling, "utf8"), "original\n");
});

test("reads --from instead of stdin and preserves exact bytes", (t) => {
  const f = fixture(t);
  const content = Buffer.from([0, 0xff, 0x0a, 0xc3, 0xa9]);
  const source = f.write("input file", content);
  const target = ".claude/commands/from-file.md";
  success(f.run([target, "--from", source], "ignored"), /Created .*\(5 bytes\)/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, target)), content);
});

test("allows empty content", (t) => {
  const f = fixture(t);
  const target = ".claude/commands/empty.md";
  success(f.run([target], ""), /Created .*\(0 bytes\)/);
  assert.equal(fs.statSync(path.join(f.root, target)).size, 0);
});

test("allows exactly 512 KiB", (t) => {
  const f = fixture(t);
  const target = ".claude/commands/limit.md";
  success(f.run([target], Buffer.alloc(MAX_BYTES, 97)), /524288 bytes/);
  assert.equal(fs.statSync(path.join(f.root, target)).size, MAX_BYTES);
});

for (const target of [".claude/skills/demo/hooks", ".claude/skills/demo/hooks/pre-tool.sh"]) {
  test(`allows skill content at ${target}`, (t) => {
    const f = fixture(t);
    success(f.run([target]), /Created/);
    assert.equal(fs.readFileSync(path.join(f.root, target), "utf8"), "replacement\n");
  });
}

for (const target of [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/settings.backup.json",
  ".claude/skills/demo/settings.json",
  ".claude/commands/settings.local.json",
  ".claude/agents/settings.custom.json",
  ".claude/skills/demo/SETTINGS.JSON",
  ".claude/skills/settings.json/alias.md",
]) {
  for (const operation of ["write", "delete"]) {
    test(`refuses ${operation} of ${target}`, (t) => {
      const f = fixture(t);
      f.write(target);
      refuse(f, [target, ...(operation === "delete" ? ["--delete"] : [])], /settings\*\.json files are refused/);
    });
  }
}

for (const target of [".claude/hooks/pre-tool.sh", ".claude/skills-extra/demo.md", "settings.json", "README.md", ".git/config", ".claude/skills"]) {
  test(`refuses outside-allowlist target ${target}`, (t) => {
    const f = fixture(t);
    refuse(f, [target], /refused|Allowed targets only/);
  });
}

test("refuses '..' even when normalization would stay inside skills", (t) => {
  const f = fixture(t);
  refuse(f, [".claude/skills/demo/../other.md"], /containing '\.\.'/);
});

test("refuses '..' escaping the allowed directory", (t) => {
  const f = fixture(t);
  refuse(f, [".claude/skills/../../outside.md"], /containing '\.\.'/);
});

test("refuses absolute target paths", (t) => {
  const f = fixture(t);
  refuse(f, [path.join(f.root, ".claude/skills/demo.md")], /Absolute target paths/);
});

test("refuses Windows absolute target paths", (t) => {
  const f = fixture(t);
  refuse(f, ["C:\\brain\\.claude\\skills\\demo.md"], /Absolute target paths/);
});

test("refuses a symlink directory escape before creating parents", (t) => {
  const f = fixture(t);
  const outside = path.join(f.temporary, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.root, ".claude/skills"), { recursive: true });
  fs.symlinkSync(outside, path.join(f.root, ".claude/skills/escape"));
  refuse(f, [".claude/skills/escape/new/deep/demo.md"], /Symlink target paths are refused/);
});

for (const component of [".claude", ".claude/skills"]) {
  test(`refuses a symlink at ${component}`, (t) => {
    const f = fixture(t);
    const outside = path.join(f.temporary, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.dirname(path.join(f.root, component)), { recursive: true });
    fs.symlinkSync(outside, path.join(f.root, component));
    refuse(f, [".claude/skills/new/demo.md"], /Symlink target paths are refused/);
  });
}

test("refuses a directory symlink even when it stays inside skills", (t) => {
  const f = fixture(t);
  const inside = path.join(f.root, ".claude/skills/real");
  fs.mkdirSync(inside, { recursive: true });
  fs.symlinkSync(inside, path.join(f.root, ".claude/skills/alias"));
  refuse(f, [".claude/skills/alias/demo.md"], /Symlink target paths are refused/);
});

for (const operation of ["write", "delete"]) {
  test(`refuses ${operation} of a final symlink target`, (t) => {
    const f = fixture(t);
    const outside = path.join(f.temporary, "outside.md");
    fs.writeFileSync(outside, "keep\n");
    fs.mkdirSync(path.join(f.root, ".claude/skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(f.root, ".claude/skills/link.md"));
    refuse(f, [".claude/skills/link.md", ...(operation === "delete" ? ["--delete"] : [])], /Symlink target paths are refused/);
  });
}

test("refuses a dangling final symlink", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, ".claude/skills"), { recursive: true });
  fs.symlinkSync(path.join(f.temporary, "missing"), path.join(f.root, ".claude/skills/link.md"));
  refuse(f, [".claude/skills/link.md"], /Symlink target paths are refused/);
});

test("refuses cwd that is not a git repository", (t) => {
  const f = fixture(t, false);
  refuse(f, [".claude/commands/demo.md"], /Run from a git repository root/);
});

test("refuses cwd that is a git subdirectory rather than the root", (t) => {
  const f = fixture(t);
  const subdirectory = path.join(f.root, "subdirectory");
  fs.mkdirSync(subdirectory);
  refuse(f, [".claude/commands/demo.md"], /Run from a git repository root/, "content", subdirectory);
});

test("refuses oversize stdin before creating directories", (t) => {
  const f = fixture(t);
  refuse(f, [".claude/skills/new/demo.md"], /exceeds the 524288-byte/, Buffer.alloc(MAX_BYTES + 1, 97));
});

test("refuses oversize --from while preserving the existing target", (t) => {
  const f = fixture(t);
  const target = ".claude/commands/demo.md";
  f.write(target);
  const source = f.write("oversize", Buffer.alloc(MAX_BYTES + 1, 97));
  refuse(f, [target, "--from", source], /exceeds the 524288-byte/);
});

test("refuses oversize UTF-8 input by bytes rather than characters", (t) => {
  const f = fixture(t);
  refuse(f, [".claude/commands/demo.md"], /exceeds the 524288-byte/, "é".repeat(MAX_BYTES / 2 + 1));
});

for (const operation of ["write", "delete"]) {
  test(`refuses ${operation} of a directory without removing contents`, (t) => {
    const f = fixture(t);
    f.write(".claude/skills/demo/keep.md");
    refuse(f, [".claude/skills/demo", ...(operation === "delete" ? ["--delete"] : [])], /Target must be a regular file/);
  });
}

test("refuses deletion of a missing file", (t) => {
  const f = fixture(t);
  refuse(f, [".claude/commands/missing.md", "--delete"], /Cannot delete a missing file/);
});

test("refuses a file as a parent component", (t) => {
  const f = fixture(t);
  f.write(".claude/skills/demo");
  refuse(f, [".claude/skills/demo/file.md"], /Target parent must be a directory/);
});

for (const args of [[], ["--delete"], [".claude/commands/demo.md", "--from"], [".claude/commands/demo.md", "--unknown"], [".claude/commands/demo.md", "--delete", "--from", "input"]]) {
  test(`refuses invalid CLI arguments ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t);
    refuse(f, args, /Usage:|cannot be combined/);
  });
}
