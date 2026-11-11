#!/usr/bin/env node
/** Constrained channel-brain file writer. No git mutations or shell evaluation. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 512 * 1024;
const MAX_MCP_BYTES = 64 * 1024;
const MAX_MCP_STRING_BYTES = 4 * 1024;
// teamvibe.ai main packages/poller/src/mcp-session.ts:159-163,187-189
// (#795, ac085e9f): reserve the union of legacy and merged base transports.
const BASE_MCP_SERVERS = new Set(["slack", "teamvibe-api", "teamvibe"]);
const LITERAL_MCP_HEADERS = new Set(["accept", "content-type", "user-agent", "mcp-protocol-version"]);
// teamvibe.ai main packages/poller/src/brain-mcp.ts:9-13,64-67 (#795, ac085e9f).
const MAX_MCP_REMINDER_BYTES = 4 * 1024;
const MCP_SUMMARY_BYTES = 128;
const USAGE = "Usage: brain-write.ts <relative-path> [--from <file>] [--delete]";

function parseArgs(args) {
  // Accept --delete <path> as well as the existing <path> --delete form.
  if (args.length === 2 && args[0] === "--delete") args = [args[1], "--delete"];
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
  const isMcp = relative === ".mcp.json";
  if (!isMcp && (parts.length < 3 || parts[0] !== ".claude" ||
      !["skills", "commands", "agents"].includes(parts[1]))) {
    throw new Error("Allowed targets only: .mcp.json, .claude/skills/**, .claude/commands/**, .claude/agents/**; hooks and other paths are refused");
  }

  // Refuse every symlink component, including dangling links and the final file.
  // Validate existing ancestors before mkdir so an escape cannot create outside dirs.
  const allowed = isMcp ? path.join(root, relative) : path.join(root, parts[0], parts[1]);
  let current = root;
  let targetStat = null;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = lstatIfPresent(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Symlink target paths are refused: ${parts.slice(0, i + 1).join("/")}`);
    if (isMcp || i >= 1) {
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

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Keep reference syntax in sync with poller brain-mcp.ts (teamvibe.ai PR #795).
const envReferences = (value) => value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g);
const secretReference = (value) => /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-)?\}(?![\s\S])/.test(value);
const credentialError = () => new Error("MCP credentials must use platform secrets: store the value via platform secrets and reference it as ${VAR} or ${VAR:-} (empty default only)");

function parseMcp(content) {
  let text;
  try {
    // Preserve the BOM so it can be refused explicitly, rather than stripped.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new Error(".mcp.json must contain valid JSON encoded as UTF-8");
  }
  if (text.startsWith("\uFEFF")) throw new Error(".mcp.json must not contain a UTF-8 BOM");

  let config;
  try {
    config = JSON.parse(text);
  } catch {
    // JSON parser errors can contain source text, including credentials.
    throw new Error(".mcp.json must contain valid JSON");
  }
  // JSON.parse checks syntax; this raw-token pass makes the parse duplicate-aware.
  // Track keys at every object depth, decoding escapes before comparing names.
  // Arrays use null frames so their commas cannot reset a containing object's key state.
  const stack = [];
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],]/g)) {
    if (token === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") {
      if (stack.at(-1)) stack.at(-1).expectKey = true;
    } else if (stack.at(-1)?.expectKey) {
      const frame = stack.at(-1);
      const key = JSON.parse(token);
      if (frame.keys.has(key)) throw new Error(".mcp.json must not contain duplicate object keys");
      frame.keys.add(key);
      frame.expectKey = false;
    }
  }
  return config;
}

function validateMcp(content) {
  const config = parseMcp(content);
  // Bound every string, including names and map keys, before field validation.
  const pending = [config];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && Buffer.byteLength(value) > MAX_MCP_STRING_BYTES) {
      throw new Error("MCP strings exceed the 4096-byte cap");
    }
    if (Array.isArray(value)) pending.push(...value);
    else if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) pending.push(key, entry);
    }
  }
  if (!isRecord(config) || !isRecord(config.mcpServers)) {
    throw new Error(".mcp.json must be an object with an mcpServers object");
  }
  if (Object.keys(config).some((key) => key !== "mcpServers")) {
    throw new Error(".mcp.json only permits the mcpServers top-level field");
  }
  const servers = Object.entries(config.mcpServers);
  if (servers.length > 32) throw new Error(".mcp.json permits at most 32 servers");
  const references = new Set();
  let reminderBytes = 0;
  const stringMap = (value, field) => {
    if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
      throw new Error(`MCP ${field} must be a string map`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (field === "headers" && LITERAL_MCP_HEADERS.has(key.toLowerCase())) continue;
      if (!secretReference(entry)) throw credentialError();
    }
  };
  for (const [name, server] of servers) {
    // Never echo invalid names, unknown fields, URLs, or input values in errors.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid MCP server name; use 1-64 letters, digits, underscores, or hyphens");
    if (BASE_MCP_SERVERS.has(name)) throw new Error(`MCP server ${name} is reserved by the base poller`);
    if (!isRecord(server)) throw new Error("MCP server must be a known transport object");
    const type = server.type === undefined ? "stdio" : server.type;
    if (!["stdio", "http", "sse"].includes(type)) throw new Error("Unknown MCP transport type; use stdio, http, or sse");
    const fields = type === "stdio" ? ["type", "command", "args", "env"] : ["type", "url", "headers"];
    if (Object.keys(server).some((key) => !fields.includes(key))) throw new Error("Unexpected fields for MCP transport");
    if (type === "stdio") {
      if (typeof server.command !== "string" || !server.command.trim()) throw new Error("MCP stdio command must be a nonempty string");
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))) {
        throw new Error("MCP stdio args must be an array of strings");
      }
      const args = server.args ?? [];
      for (let i = 0; i < args.length; i++) {
        const assignment = args[i].match(/(?:token|key|secret|password|auth)=([\s\S]*)/i);
        if (assignment && !secretReference(assignment[1])) throw credentialError();
        if (/^--(?:token|api-key|key|secret|password|auth)$/i.test(args[i]) &&
            i + 1 < args.length && !secretReference(args[i + 1])) throw credentialError();
      }
      if (server.env !== undefined) stringMap(server.env, "env");
    } else {
      let url;
      try {
        if (typeof server.url !== "string" || !server.url.trim()) throw new Error();
        url = new URL(server.url);
      } catch {
        throw new Error("MCP http/sse url must be a valid URL");
      }
      if (url.username || url.password || /^[^:]+:\/\/[^/?#]*@/.test(server.url) ||
          server.url.includes("?") || server.url.includes("#")) {
        throw new Error("MCP url must not contain userinfo, a query string, or a fragment");
      }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
        throw new Error("MCP url must use https, or http only for localhost");
      }
      if (server.headers !== undefined) stringMap(server.headers, "headers");
    }
    // Mirror teamvibe.ai main packages/poller/src/brain-mcp.ts:125-140 (#795,
    // ac085e9f), using the largest missing-variable list for any spawn environment.
    const serverReferences = new Set();
    const required = new Set();
    const collect = (value) => {
      if (typeof value === "string") {
        for (const match of envReferences(value)) {
          serverReferences.add(match[1]);
          references.add(match[1]);
          if (match[2] === undefined) required.add(match[1]);
        }
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (isRecord(value)) Object.values(value).forEach(collect);
    };
    for (const field of ["command", "args", "env", "url", "headers"]) collect(server[field]);
    const names = [...serverReferences].sort();
    const missing = names.filter((key) => required.has(key)).join(", ");
    // For short names, the poller's "none" label can be longer than all missing.
    const missingLabel = missing.length > 4 ? missing : "none";
    const line = `- Brain MCP ${name}: env references: ${names.join(", ") || "none"}; missing in spawn env: ${missingLabel}.`;
    reminderBytes += Buffer.byteLength(line) + (reminderBytes ? 1 : 0);
    if (reminderBytes > MAX_MCP_REMINDER_BYTES - MCP_SUMMARY_BYTES) {
      throw new Error("MCP metadata exceeds the poller's 4096-byte reminder budget (including missing-variable names and 128 reserved summary bytes); reduce servers or reference names");
    }
  }
  const canonical = Buffer.from(JSON.stringify(config, null, 2) + "\n");
  if (canonical.length > MAX_MCP_BYTES) throw new Error("Canonical .mcp.json exceeds the 65536-byte (64 KiB) size cap");
  const summary = `MCP servers: ${servers.map(([name]) => name).sort().join(", ") || "none"}; env references: ${[...references].sort().join(", ") || "none"}`;
  return { content: canonical, summary };
}

async function readContent(from, maxBytes = MAX_BYTES) {
  if (from !== undefined && !fs.statSync(from).isFile()) throw new Error("--from must name a regular file");
  if (from === undefined && process.stdin.isTTY) throw new Error("Supply content on stdin or use --from <file>");
  const input = from === undefined ? process.stdin : fs.createReadStream(from);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`Content exceeds the ${maxBytes}-byte (${maxBytes / 1024} KiB) size cap`);
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

    const isMcp = target === ".mcp.json";
    const input = await readContent(from, isMcp ? MAX_MCP_BYTES : MAX_BYTES);
    const validated = isMcp ? validateMcp(input) : undefined;
    const content = validated?.content ?? input;
    const mcpSummary = validated?.summary;
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
            if (mcpSummary) console.log(mcpSummary);
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
      if (mcpSummary) console.log(mcpSummary);
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
