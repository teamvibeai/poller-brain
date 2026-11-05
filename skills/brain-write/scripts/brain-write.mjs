#!/usr/bin/env node
/** Constrained channel-brain file writer. No git mutations or shell evaluation. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 512 * 1024;
const USAGE = "Usage: brain-write.ts <relative-path> [--from <file>] [--delete]";

function parseArgs(args) {
  const [target, ...options] = args;
  if (!target || target.startsWith("--")) throw new Error(USAGE);
  let from;
  let remove = false;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "--from" && from === undefined) {
      from = options[++i];
      if (!from || from.startsWith("--")) throw new Error(USAGE);
    } else if (options[i] === "--delete" && !remove) {
      remove = true;
    } else {
      throw new Error(`Unknown or repeated option: ${options[i]}. ${USAGE}`);
    }
  }
  if (remove && from !== undefined) throw new Error("--delete cannot be combined with --from");
  return { target, from, remove };
}

function brainRoot() {
  const cwd = fs.realpathSync(process.cwd());
  refuseBaseBrain(cwd);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (fs.realpathSync(top) === cwd) return cwd;
  } catch {
    // Report the same actionable error for a non-repo and a repo subdirectory.
  }
  throw new Error("Run from a git repository root: cwd must equal git rev-parse --show-toplevel");
}

function refuseBaseBrain(root) {
  for (const name of ["CLAUDE_CONFIG_DIR", "BRAIN_ROOT"]) {
    if (!process.env[name]) continue;
    let base;
    try {
      base = fs.realpathSync(process.env[name]);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (root === base || root.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) {
      throw new Error(`The base brain is never writable: cwd is at or inside $${name}`);
    }
  }
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateTarget(root, relative) {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new Error("Absolute target paths are refused; use a path relative to the brain root");
  }
  const parts = relative.split("/");
  if (parts.some((part) => part === "..")) throw new Error("Paths containing '..' are refused");
  if (relative.includes("\\") || /[\x00-\x1f\x7f]/.test(relative) ||
      parts.some((part) => !part || part === ".")) {
    throw new Error("Use a plain relative path without empty, '.', backslash, or control-character components");
  }
  if (parts.some((part) => /^settings.*\.json$/i.test(part))) {
    throw new Error("settings*.json files are refused anywhere; propose configuration changes via Slack approval");
  }
  if (parts.length < 3 || parts[0] !== ".claude" ||
      !["skills", "commands", "agents"].includes(parts[1])) {
    throw new Error("Allowed targets only: .claude/skills/**, .claude/commands/**, .claude/agents/**; hooks and other paths are refused");
  }

  // Refuse every symlink component, including dangling links and the final file.
  // Validate existing ancestors before mkdir so an escape cannot create outside dirs.
  const allowed = path.join(root, parts[0], parts[1]);
  let current = root;
  let targetStat = null;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = lstatIfPresent(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Symlink target paths are refused: ${parts.slice(0, i + 1).join("/")}`);
    if (i >= 1) {
      const real = fs.realpathSync(current);
      if (real !== allowed && !real.startsWith(allowed + path.sep)) {
        throw new Error("Resolved target or existing parent escapes the allowed directory");
      }
    }
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error("Target parent must be a directory");
    if (i === parts.length - 1) {
      if (!stat.isFile()) throw new Error("Target must be a regular file; directories are never written or deleted");
      targetStat = stat;
    }
  }
  return { absolute: current, stat: targetStat };
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Keep every directory open, including while making missing parents. On Linux,
// /proc/self/fd supplies the dirfd-relative operations missing from Node's API:
// swapping a pathname for a symlink cannot redirect mkdir/open/rename/unlink.
// Other platforms (notably macOS) have no traversable directory-fd paths. There
// we check realpath and dev/ino immediately before each operation, but a residual
// check-to-syscall race remains; Node exposes no openat/renameat/unlinkat there.
// Even on Linux a directory can be moved after verification: an operation can
// still affect that pinned directory, but cannot follow its replacement link.
function openParent(root, relative, create) {
  const directories = [];
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const close = () => {
    for (const directory of directories.reverse()) fs.closeSync(directory.fd);
  };
  const verify = () => {
    refuseBaseBrain(root);
    for (const directory of directories) {
      const stat = fs.lstatSync(directory.absolute);
      if (!stat.isDirectory() || !sameFile(stat, fs.fstatSync(directory.fd)) ||
          fs.realpathSync(directory.absolute) !== directory.absolute ||
          (directory.pinned && fs.realpathSync(directory.access) !== directory.absolute)) {
        throw new Error("Target parent changed or escaped the allowed directory");
      }
    }
  };
  const open = (absolute, access) => {
    const fd = fs.openSync(access, flags);
    const pinned = process.platform === "linux";
    directories.push({ absolute, fd, pinned, access: pinned ? `/proc/self/fd/${fd}` : absolute });
    // Verify AFTER opening: path validation alone cannot establish fd identity.
    verify();
  };
  try {
    open(root, root);
    for (const part of relative.split("/").slice(0, -1)) {
      const parent = directories.at(-1);
      const absolute = path.join(parent.absolute, part);
      const access = path.join(parent.access, part);
      verify();
      if (!lstatIfPresent(access) && create) {
        verify();
        fs.mkdirSync(access);
      }
      open(absolute, access);
    }
    const parent = directories.at(-1);
    return { file: (name) => path.join(parent.access, name), verify, close };
  } catch (error) {
    close();
    throw error;
  }
}

function regularFile(file) {
  const stat = lstatIfPresent(file);
  if (stat?.isSymbolicLink()) throw new Error("Symlink target paths are refused");
  if (stat && !stat.isFile()) throw new Error("Target must be a regular file; directories are never written or deleted");
  return stat;
}

async function readContent(from) {
  if (from !== undefined && !fs.statSync(from).isFile()) throw new Error("--from must name a regular file");
  if (from === undefined && process.stdin.isTTY) throw new Error("Supply content on stdin or use --from <file>");
  const input = from === undefined ? process.stdin : fs.createReadStream(from);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BYTES) throw new Error(`Content exceeds the ${MAX_BYTES}-byte (512 KiB) size cap`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { target, from, remove } = parseArgs(args);
    const root = brainRoot();
    const checked = validateTarget(root, target);
    if (remove) {
      // Missing parents must not be created by a deletion.
      if (!checked.stat) throw new Error("Cannot delete a missing file");
      const parent = openParent(root, target, false);
      try {
        const file = parent.file(path.basename(target));
        const stat = regularFile(file);
        if (!stat) throw new Error("Cannot delete a missing file");
        parent.verify();
        fs.unlinkSync(file);
        console.log(`Deleted ${target} (${stat.size} bytes)`);
      } finally {
        parent.close();
      }
      return;
    }

    const content = await readContent(from);
    // Input may have waited on stdin; check again before touching the target tree.
    validateTarget(root, target);
    const parent = openParent(root, target, true);
    const file = parent.file(path.basename(target));
    const temporary = parent.file(`.brain-write-${randomUUID()}.tmp`);
    let created = false;
    try {
      const stat = regularFile(file);
      if (stat?.size === content.length) {
        parent.verify();
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          parent.verify();
          if (!sameFile(stat, fs.fstatSync(fd))) throw new Error("Target changed while opening");
          if (fs.readFileSync(fd).equals(content)) {
            console.log(`Unchanged ${target} (${content.length} bytes)`);
            return;
          }
        } finally {
          fs.closeSync(fd);
        }
      }
      // Exclusive creation avoids following an existing temporary-file symlink.
      parent.verify();
      const fd = fs.openSync(temporary, "wx", 0o666);
      created = true;
      try {
        parent.verify();
        fs.writeFileSync(fd, content);
        if (stat) fs.fchmodSync(fd, stat.mode & 0o777);
      } finally {
        fs.closeSync(fd);
      }
      regularFile(file);
      parent.verify();
      fs.renameSync(temporary, file);
      created = false;
      console.log(stat
        ? `Updated ${target} (${stat.size} -> ${content.length} bytes)`
        : `Created ${target} (${content.length} bytes)`);
    } finally {
      try {
        if (created) {
          // Never clean up using a replaced parent path on the portable fallback.
          parent.verify();
          if (lstatIfPresent(temporary)) fs.unlinkSync(temporary);
        }
      } finally {
        parent.close();
      }
    }
  } catch (error) {
    console.error(`brain-write: ${error.message}`);
    process.exitCode = 1;
  }
}

// Also runnable with plain Node for the repository's test runner.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
