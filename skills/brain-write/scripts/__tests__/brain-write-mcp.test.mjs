// Run: node skills/brain-write/scripts/__tests__/brain-write-mcp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../brain-write.mjs", import.meta.url));
const config = (server = { command: "node" }, name = "demo") => JSON.stringify({ mcpServers: { [name]: server } });
const http = { type: "http", url: "https://example.test/mcp" };

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-mcp-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, "base"), BRAIN_ROOT: path.join(root, "base") };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const init = spawnSync("git", ["init", "--quiet", root], { env, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const run = (input, args = [".mcp.json"]) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, env, input, encoding: "utf8", timeout: 10000,
  });
  return { root, run };
}

function success(result, message = /Created/) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, message);
}

function refuse(f, input, reason, args) {
  const target = path.join(f.root, ".mcp.json");
  fs.writeFileSync(target, config());
  const before = fs.readFileSync(target);
  const entries = fs.readdirSync(f.root);
  const result = f.run(input, args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, reason);
  assert.deepEqual(fs.readFileSync(target), before, "invalid input must preserve the existing file");
  assert.deepEqual(fs.readdirSync(f.root), entries, "invalid input must leave no temporary files");
  return result;
}

test("creates, updates atomically, and reports unchanged root .mcp.json", (t) => {
  const f = fixture(t);
  const target = path.join(f.root, ".mcp.json");
  const original = config();
  success(f.run(original));
  assert.equal(fs.readFileSync(target, "utf8"), original);
  fs.chmodSync(target, 0o640);
  const inode = fs.statSync(target).ino;
  const replacement = config(http, "sitebrew");
  const source = path.join(f.root, "input.json");
  fs.writeFileSync(source, replacement);
  success(f.run("ignored", [".mcp.json", "--from", source]), /Updated.*\n.*servers: sitebrew; env references: none/i);
  assert.notEqual(fs.statSync(target).ino, inode);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  const updatedInode = fs.statSync(target).ino;
  success(f.run(replacement), /Unchanged.*\n.*servers: sitebrew; env references: none/i);
  assert.equal(fs.statSync(target).ino, updatedInode);
  assert.equal(fs.readFileSync(target, "utf8"), replacement);
  assert.equal(fs.existsSync(path.join(f.root, ".git/index")), false);
});

for (const args of [[".mcp.json", "--delete"], ["--delete", ".mcp.json"]]) {
  test(`deletes root .mcp.json using ${args.join(" ")} even when its existing content is invalid`, (t) => {
    const f = fixture(t);
    const target = path.join(f.root, ".mcp.json");
    fs.writeFileSync(target, "invalid old config");
    success(f.run(undefined, args), /Deleted \.mcp\.json/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(f.root, ".claude")), false);
  });
}

for (const target of ["README.md", "other.json", ".mcp.json.bak", ".MCP.json", "nested/.mcp.json", ".mcp.json/child", "./.mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/demo.sh"]) {
  for (const remove of [false, true]) {
    test(`refuses ${remove ? "delete" : "write"} outside literal MCP target: ${target}`, (t) => {
      refuse(fixture(t), config(), /refused|Allowed targets only|plain relative path/, [target, ...(remove ? ["--delete"] : [])]);
    });
  }
}

for (const server of [
  { command: "node" },
  { type: "stdio", command: "node", args: ["server.js", "${ARG}"], env: { MODE: "production", API_KEY: "${KEY}" } },
  http,
  { type: "sse", url: "https://example.test/sse", headers: { Authorization: "Bearer ${TOKEN:-}", Accept: "text/event-stream" } },
  ...["localhost", "127.0.0.1", "[::1]"].map(host => ({ type: "http", url: `http://${host}:1234/mcp` })),
]) {
  test(`allows known transport ${JSON.stringify(server)}`, (t) => {
    const f = fixture(t);
    const content = config(server);
    success(f.run(content));
    assert.equal(fs.readFileSync(path.join(f.root, ".mcp.json"), "utf8"), content);
  });
}

const invalid = [
  ["invalid JSON", '{"private":"DO_NOT_ECHO",', /valid JSON/],
  ["invalid UTF-8 JSON", Buffer.concat([Buffer.from('{"mcpServers":{"demo":{"command":"'), Buffer.from([0xff]), Buffer.from('"}}}')]), /valid JSON/],
  ...[null, [], "text", 1, {}, { mcpServers: null }, { mcpServers: [] }, { mcpServers: "bad" }, { mcpServers: {}, extra: {} }]
    .map(value => ["invalid document " + JSON.stringify(value), JSON.stringify(value), /mcpServers|top-level/]),
  ...[
    null, [], "text", {}, { command: "" }, { command: "  " }, { command: 1 },
    { type: "websocket", url: "https://example.test" }, { type: null, command: "node" },
    { type: "http" }, { type: "sse" }, { type: "http", url: 1 }, { type: "sse", url: " " },
    { command: "node", args: "bad" }, { command: "node", args: [1] },
    { command: "node", env: null }, { command: "node", env: [] }, { command: "node", env: { MODE: 1 } },
    { ...http, headers: null }, { ...http, headers: [] }, { ...http, headers: { Accept: false } },
    { command: "node", url: "https://example.test" }, { command: "node", headers: {} },
    { ...http, command: "node" }, { ...http, args: [] }, { ...http, env: {} },
    { ...http, unknown: true }, { command: "node", unknown: true },
  ].map(value => ["invalid server " + JSON.stringify(value), config(value), /transport|command|args|env|headers|url|fields/]),
  ...["http://example.test/mcp", "http://localhost.evil.test", "http://localhost@evil.test", "ftp://localhost/mcp", "/relative", "https://", "javascript:alert(1)"]
    .map(url => ["unsafe URL " + url, config({ ...http, url }), /url|https|localhost/]),
  ...["", "bad.name", "bad name", "bad\nname", "demo\n", "slack\n", "demo\r", "demo\u2028", "demo\u2029", "é", "a".repeat(65)]
    .map(name => ["invalid name " + JSON.stringify(name), config(http, name), /server name/]),
  ...["slack", "teamvibe-api"].map(name => ["reserved " + name, config(http, name), /reserved.*base/]),
];
for (const [label, input, reason] of invalid) {
  test(`refuses ${label} without mutation`, (t) => {
    const result = refuse(fixture(t), input, reason);
    assert.doesNotMatch(result.stderr, /DO_NOT_ECHO|bad\nname/);
  });
}

for (const field of ["env", "headers"]) {
  for (const key of ["TOKEN", "clientSecret", "api_key", "Authorization", "Password"]) {
    test(`refuses literal secret in ${field}.${key} with platform secrets guidance`, (t) => {
      const server = field === "env" ? { command: "node" } : http;
      const result = refuse(fixture(t), config({ ...server, [field]: { [key]: "DO_NOT_ECHO" } }), /platform secrets.*\$\{VAR\}/);
      assert.doesNotMatch(result.stderr, /DO_NOT_ECHO/);
    });
  }
  for (const value of ["${TOKEN}", "${TOKEN:-}", "Bearer ${TOKEN:-private-default}"]) {
    test(`accepts ${field} secret reference ${value} without printing its value`, (t) => {
      const f = fixture(t);
      const server = field === "env" ? { command: "node" } : http;
      const result = f.run(config({ ...server, [field]: { API_KEY: value } }));
      success(result, /env references: TOKEN/);
      assert.doesNotMatch(result.stdout + result.stderr, /private-default|Bearer|\$\{/);
    });
  }
  for (const value of ["Bearer DO_NOT_ECHO", "bearer DO_NOT_ECHO", "Basic DO_NOT_ECHO", "sk-private", "sk_test_private", "tvp_private", "ghp_private", "github_pat_private", "xoxb-private", "eyJhbGciOiJIUzI1NiJ9.payload.signature", "-----BEGIN PRIVATE KEY-----\nDO_NOT_ECHO\n-----END PRIVATE KEY-----"]) {
    test(`refuses credential-looking ${field} value ${value} under an ordinary key`, (t) => {
      const server = field === "env" ? { command: "node" } : http;
      const result = refuse(fixture(t), config({ ...server, [field]: { OTHER: value } }), /platform secrets.*\$\{VAR\}/);
      assert.doesNotMatch(result.stderr, /DO_NOT_ECHO|private|payload/);
    });
  }
  test(`refuses malformed secret references in ${field}`, (t) => {
    const server = field === "env" ? { command: "node" } : http;
    for (const value of ["$TOKEN", "${}", "${1TOKEN}", "${TOKEN", "${TOKEN-default}"]) {
      refuse(fixture(t), config({ ...server, [field]: { API_KEY: value } }), /platform secrets.*\$\{VAR\}/);
    }
  });
  for (const bytes of [4096, 4097]) {
    test(`${field} value ${bytes === 4096 ? "at" : "over"} 4 KiB boundary`, (t) => {
      const f = fixture(t);
      const server = field === "env" ? { command: "node" } : http;
      const input = config({ ...server, [field]: { OTHER: "é".repeat(Math.floor(bytes / 2)) + (bytes % 2 ? "x" : "") } });
      if (bytes === 4096) success(f.run(input));
      else refuse(f, input, /4096-byte/);
    });
  }
}

test("reports all server names and deduplicated reference names across transport fields only", (t) => {
  const f = fixture(t);
  const result = f.run(JSON.stringify({ mcpServers: {
    zed: { ...http, url: "https://example.test/${HOST:-private-host}", headers: { Authorization: "Bearer ${TOKEN:-private-token}", Other: "${TOKEN}" } },
    alpha: { command: "${EXEC:-private-command}", args: ["${ARG:-private-arg}"], env: { API_KEY: "${TOKEN}" } },
  } }));
  success(result, /servers: alpha, zed; env references: ARG, EXEC, HOST, TOKEN/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-|https:|Bearer|\$\{/);
});

for (const count of [0, 32, 33]) {
  test(`server count ${count}`, (t) => {
    const f = fixture(t);
    const input = JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: count }, (_, i) => [`server_${i}`, http])) });
    if (count <= 32) success(f.run(input));
    else refuse(f, input, /32 servers/);
  });
}

test("allows a 64-character server name", (t) => {
  success(fixture(t).run(config(http, "a".repeat(64))));
});

for (const from of [false, true]) {
  for (const bytes of [65536, 65537]) {
    test(`${from ? "--from" : "stdin"} MCP file ${bytes === 65536 ? "at" : "over"} 64 KiB boundary`, (t) => {
      const f = fixture(t);
      const input = JSON.stringify({ mcpServers: {} }).padEnd(bytes, " ");
      let args;
      if (from) {
        const source = path.join(f.root, "input.json");
        fs.writeFileSync(source, input);
        args = [".mcp.json", "--from", source];
      }
      if (bytes === 65536) success(f.run(input, args), /65536 bytes/);
      else refuse(f, input, /65536-byte/, args);
    });
  }
}

for (const remove of [false, true]) {
  test(`refuses ${remove ? "delete" : "write"} of a root MCP symlink`, (t) => {
    const f = fixture(t);
    const outside = path.join(f.root, "outside.json");
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(f.root, ".mcp.json"));
    const result = f.run(config(), [".mcp.json", ...(remove ? ["--delete"] : [])]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Symlink target paths are refused/);
    assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  });
}
