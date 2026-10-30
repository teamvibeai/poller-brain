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
    let checked = validateTarget(root, target);
    if (remove) {
      if (!checked.stat) throw new Error("Cannot delete a missing file");
      fs.unlinkSync(checked.absolute);
      console.log(`Deleted ${target} (${checked.stat.size} bytes)`);
      return;
    }

    const content = await readContent(from);
    // Input may have waited on stdin; check again before touching the target tree.
    checked = validateTarget(root, target);
    if (checked.stat?.size === content.length && fs.readFileSync(checked.absolute).equals(content)) {
      console.log(`Unchanged ${target} (${content.length} bytes)`);
      return;
    }
    fs.mkdirSync(path.dirname(checked.absolute), { recursive: true });
    validateTarget(root, target);
    const temporary = path.join(path.dirname(checked.absolute), `.brain-write-${randomUUID()}.tmp`);
    let created = false;
    try {
      // Exclusive creation avoids following an existing temporary-file symlink.
      const fd = fs.openSync(temporary, "wx", 0o666);
      created = true;
      try {
        fs.writeFileSync(fd, content);
        if (checked.stat) fs.fchmodSync(fd, checked.stat.mode & 0o777);
      } finally {
        fs.closeSync(fd);
      }
      validateTarget(root, target);
      fs.renameSync(temporary, checked.absolute);
    } finally {
      if (created && lstatIfPresent(temporary)) fs.unlinkSync(temporary);
    }
    console.log(checked.stat
      ? `Updated ${target} (${checked.stat.size} -> ${content.length} bytes)`
      : `Created ${target} (${content.length} bytes)`);
  } catch (error) {
    console.error(`brain-write: ${error.message}`);
    process.exitCode = 1;
  }
}

// Also runnable with plain Node for the repository's test runner.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
