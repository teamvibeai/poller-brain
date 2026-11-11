// Run: node skills/brain-write/scripts/__tests__/brain-write-mcp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = process.env.BRAIN_WRITE_TEST_SCRIPT || fileURLToPath(new URL("../brain-write.mjs", import.meta.url));
const config = (server = { command: "node" }, name = "demo") => JSON.stringify({ mcpServers: { [name]: server } });
const canonical = (input) => JSON.stringify(JSON.parse(input), null, 2) + "\n";
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
  return { root, run, env };
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

// Review round 1: these all wrote unsafe or poller-incompatible bytes at 18abc08.
const review1 = [
  ["1 mixed literal env", config({ command: "node", env: { API_KEY: "sk-private ${DUMMY}" } }), /platform secrets/],
  ["1 literal fallback env", config({ command: "node", env: { API_KEY: "${TOKEN:-literal-secret}" } }), /platform secrets/],
  ["2 credential arg", config({ command: "node", args: ["--token", "sk-private"] }), /platform secrets/],
  ["2 URL query", config({ ...http, url: "https://example.test/mcp?api_key=sk-private" }), /url/],
  ["2 URL userinfo", config({ ...http, url: "https://user:sk-private@example.test/mcp" }), /url/],
  ["2 Cookie header", config({ ...http, headers: { Cookie: "session=sk-private" } }), /platform secrets/],
  ["3 reserved teamvibe", config({ command: "node" }, "teamvibe"), /reserved/],
  ["4 duplicate keys", '{"mcpServers":{"demo":{"command":"node","env":{"API_KEY":"sk-private","API_KEY":"${TOKEN}"}}}}', /duplicate/i],
  ["5 oversized arg", config({ command: "node", args: ["x".repeat(4097)] }), /4096-byte/],
  ["5 oversized URL", config({ ...http, url: "https://example.test/" + "x".repeat(4097) }), /4096-byte/],
  ["6 UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(config())]), /BOM/],
  ["7 metadata budget", JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [
    `server${i}`, { command: "node", env: { KEY: "${" + "V".repeat(100) + "}" } },
  ])) }), /4096-byte.*reminder|reminder.*4096-byte/],
];
// One shared positive/negative matrix exercises the CLI, not an isolated regex.
const credentialMatrix = review1.map(([label, input, reason]) => [
  `review1 ${label}`, input, reason,
]);
const positions = {
  env: (name, value) => ({ command: "node", env: { [name]: value } }),
  header: (name, value) => ({ ...http, headers: { [name]: value } }),
  assigned: (name, value) => ({ command: "node", args: [`--${name}=${value}`] }),
  separate: (name, value) => ({ command: "node", args: [`--${name}`, value] }),
};
const credentialNames = [
  "secret", "token", "password", "passwd", "pwd", "credential", "credentials",
  "auth", "Authorization", "bearer", "cookie", "apikey", "privatekey",
  "API_KEY", "access-key", "private.key", "secretKey", "clientKey", "signing-key",
  "client-secret", "access-token", "clientSecret", "accessToken", "proxyAuth",
  "Proxy-Authorization", "Cookie", "X-Api-Key", "X-Auth-Token",
];
for (const [position, server] of Object.entries(positions)) {
  for (const name of credentialNames) {
    credentialMatrix.push(
      [`${position} credential name ${name}`, config(server(name, "DO_NOT_ECHO")), /platform secrets/],
      [`${position} credential reference ${name}`, config(server(name, "${TOKEN}"))],
    );
  }
  for (const name of ["key", "sort-key", "primary-key", "monkey", "tokenizer", "author", "secretary", "NODE_ENV", "X-Session"]) {
    credentialMatrix.push([`${position} ordinary name ${name}`, config(server(name, "production"))]);
  }
  for (const value of ["${TOKEN}", "${TOKEN:-}", "${token}", "${api_key}", "${api_key:-}", "Bearer ${api_key}", "Bearer ${TOKEN}", "Bearer ${TOKEN:-}", "Basic ${TOKEN}", "Token ${TOKEN:-}", "${AKIA_TOKEN}", "${GHP_TOKEN:-}"]) {
    credentialMatrix.push([`${position} exact reference ${value}`, config(server("API_KEY", value))]);
  }
  for (const value of [
    "$TOKEN", "${}", "${1TOKEN}", "${TOKEN", "${TOKEN-default}",
    "${TOKEN}\n", "${TOKEN}\r", "${TOKEN}\u2028", "${TOKEN}\u2029", " ${TOKEN}", "${TOKEN} ",
    "${TOKEN}${OTHER}", "prefix ${TOKEN}", "${TOKEN:-DO_NOT_ECHO}", "${TOKEN:-}${OTHER}",
    "Bearer ${TOKEN} DO_NOT_ECHO", "Bearer  ${TOKEN}", "bearer ${TOKEN}", "plain text", "",
  ]) {
    credentialMatrix.push([`${position} invalid reference ${JSON.stringify(value)}`, config(server("API_KEY", value)), /platform secrets/]);
  }
}
// Review2 repros: separated multi-segment flags, allowlisted headers, legitimate
// scheme references (HTTP and SSE), ordinary env literals, and a non-secret key flag.
credentialMatrix.push(
  ["review2 --client-secret literal", config({ command: "node", args: ["--client-secret", "sk-private"] }), /platform secrets/],
  ["review2 --access-token literal", config({ command: "node", args: ["--access-token", "sk-private"] }), /platform secrets/],
  ["review2 User-Agent literal secret", config({ ...http, headers: { "User-Agent": "Bearer sk-private" } }), /platform secrets/],
  ["review2 HTTP scheme reference", config({ ...http, headers: { Authorization: "Bearer ${TOKEN}" } })],
  ["review2 SSE scheme reference", config({ type: "sse", url: "https://example.test/sse", headers: { Authorization: "Bearer ${TOKEN:-}" } })],
  ["review2 ordinary env", config({ command: "node", env: { NODE_ENV: "production" } })],
  ["review2 sort-key", config({ command: "node", args: ["server.js", "--sort-key=name"] })],
  ["ordinary npx invocation", config({ command: "npx", args: ["-y", "@scope/server"] })],
  ["missing credential flag value", config({ command: "node", args: ["--client-secret"] }), /platform secrets/],
  ["credential flag followed by another flag", config({ command: "node", args: ["--access-token", "--verbose"] }), /platform secrets/],
  ["IPv4 URL is not a three-segment JWT", config({ type: "http", url: "http://127.0.0.1:1234/mcp" })],
);
for (const assignment of ["TOKEN", "clientKey", "client_secret", "Password", "proxyAuth"]) {
  credentialMatrix.push(
    [`anchored assignment ${assignment} literal`, config({ command: "node", args: [`${assignment}=DO_NOT_ECHO`] }), /platform secrets/],
    [`anchored assignment ${assignment} reference`, config({ command: "node", args: [assignment + "=${TOKEN}"] })],
  );
}
for (const key of ["Accept", "content-type", "USER-AGENT", "Mcp-Protocol-Version", "X-Session", "Accept "]) {
  credentialMatrix.push([`ordinary header ${key}`, config({ ...http, headers: { [key]: "ordinary literal" } })]);
}
const literalPositions = {
  env: value => ({ command: "node", env: { NODE_ENV: value } }),
  header: value => ({ ...http, headers: { "User-Agent": value } }),
  arg: value => ({ command: "node", args: [value] }),
  command: value => ({ command: value }),
  url: value => ({ ...http, url: `https://example.test/${value}` }),
};
for (const [position, server] of Object.entries(literalPositions)) {
  for (const value of [
    "Bearer DO_NOT_ECHO", "bearer DO_NOT_ECHO", "Basic DO_NOT_ECHO", "Token DO_NOT_ECHO",
    "sk-private", "sk_test_private", "tvp_private", "ghp_private", "gho_private", "github_pat_private",
    "xoxa-private", "xoxb-private", "xoxp-private", "xoxr-private", "AKIA_PRIVATE", "glpat-private",
    "eyJhbGciOiJIUzI1NiJ9.payload1234.signature12", "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nDO_NOT_ECHO\n-----END PRIVATE KEY-----",
    "prefix sk-private ${DUMMY}", "${DUMMY:-ghp_private}", "Bearer ${TOKEN:-DO_NOT_ECHO}",
  ]) {
    credentialMatrix.push([`${position} literal secret ${JSON.stringify(value)}`, config(server(value)), /platform secrets/]);
  }
  // Retain the former negative dotted inputs with corrected JWT expectations.
  for (const value of ["${TOKEN}", "${TOKEN:-}", "Bearer ${TOKEN}", "Basic ${TOKEN:-}", "Token ${TOKEN}", "${AKIA_TOKEN}", "${GHP_TOKEN:-}", "abc.def.ghi.jkl", "abc.def.ghi", "eyJhbGciOiJIUzI1NiJ9.payload.signature"]) {
    credentialMatrix.push([`${position} ordinary reference ${value}`, config(server(value))]);
  }
}

// Historical cases from 99a2230 retain their exact input positions. Corrected
// expectations: ordinary names/--key and Bearer references are allowed, and a
// short dotted string is not a JWT. No historical negative input is dropped.
for (const [position, server] of Object.entries({ env: positions.env, headers: positions.header })) {
  for (const key of ["MODE", "Cookie", "X-Session", "Accept "]) {
    credentialMatrix.push([`99a2230 ${position} literal ${key}`, config(server(key, "ordinary literal")),
      key === "Cookie" ? /platform secrets/ : undefined]);
  }
  for (const key of ["TOKEN", "clientSecret", "api_key", "Authorization", "Password"]) {
    credentialMatrix.push([`99a2230 ${position} credential ${key}`, config(server(key, "DO_NOT_ECHO")), /platform secrets/]);
  }
  for (const value of ["${TOKEN}", "${TOKEN:-}"]) {
    credentialMatrix.push([`99a2230 ${position} reference ${value}`, config(server("API_KEY", value))]);
  }
  for (const value of [
    "Bearer DO_NOT_ECHO", "bearer DO_NOT_ECHO", "Basic DO_NOT_ECHO", "sk-private", "sk_test_private", "tvp_private",
    "ghp_private", "github_pat_private", "xoxb-private", "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "-----BEGIN PRIVATE KEY-----\nDO_NOT_ECHO\n-----END PRIVATE KEY-----",
  ]) {
    credentialMatrix.push([`99a2230 ${position} ordinary-key literal ${JSON.stringify(value)}`, config(server("OTHER", value)),
      value === "eyJhbGciOiJIUzI1NiJ9.payload.signature" ? undefined : /platform secrets/]);
  }
  for (const value of [
    "$TOKEN", "${}", "${1TOKEN}", "${TOKEN", "${TOKEN-default}", "${TOKEN}\n", " ${TOKEN}", "${TOKEN} ",
    "${TOKEN}${OTHER}", "Bearer ${TOKEN}", "${TOKEN:-private-default}", "${TOKEN:-}${OTHER}", "plain text", "",
  ]) {
    credentialMatrix.push([`99a2230 ${position} malformed reference ${JSON.stringify(value)}`, config(server("API_KEY", value)),
      value === "Bearer ${TOKEN}" ? undefined : /platform secrets/]);
  }
}
for (const flag of ["token", "API-KEY", "key", "SECRET", "password", "Auth"]) {
  for (const position of ["assigned", "separate"]) {
    for (const value of ["DO_NOT_ECHO", "prefix ${TOKEN}", "${TOKEN:-DO_NOT_ECHO}", "${TOKEN}${OTHER}", "${TOKEN}\n", "", "${TOKEN}", "${TOKEN:-}"]) {
      credentialMatrix.push([`99a2230 ${position} --${flag} ${JSON.stringify(value)}`, config(positions[position](flag, value)),
        flag === "key" || value === "${TOKEN}" || value === "${TOKEN:-}" ? undefined : /platform secrets/]);
    }
  }
}

// Verify3 regressions, expanded across positions so a field cannot silently
// lose either the literal detector or the shared reference grammar again.
const everyStringPosition = {
  ...literalPositions,
  ordinaryHeader: value => positions.header("OTHER", value),
  ordinaryEnv: value => positions.env("OTHER", value),
  assigned: value => positions.assigned("other", value),
  separate: value => positions.separate("other", value),
  fileAssigned: value => positions.assigned("token-file", value),
  fileSeparate: value => positions.separate("token-file", value),
  envKey: value => positions.env(value, "production"),
  headerKey: value => positions.header(value, "production"),
};
const prefixSamples = [
  "sk_test_DO_NOT_ECHO", "sk-DO_NOT_ECHO", "tvp_DO_NOT_ECHO", "ghp_DO_NOT_ECHO", "gho_DO_NOT_ECHO",
  "github_pat_DO_NOT_ECHO", "xoxa-DO_NOT_ECHO", "xoxb-DO_NOT_ECHO", "xoxp-DO_NOT_ECHO", "xoxr-DO_NOT_ECHO",
  "AKIADO_NOT_ECHO", "glpat-DO_NOT_ECHO",
];
for (const [position, server] of Object.entries(everyStringPosition)) {
  for (const [i, value] of prefixSamples.entries()) {
    credentialMatrix.push([`verify3 P1 prefix ${i} in ${position}`, config(server(value)), /platform secrets/]);
  }
}
for (const [i, name] of prefixSamples.entries()) {
  credentialMatrix.push([`verify3 P1 prefix ${i} in server name`, config({ command: "node" }, name), /platform secrets/]);
}
credentialMatrix.push(
  ["verify3 P2 JWT https URL", config({ ...http, url: "https://mcp.example.com/mcp" })],
  ["verify3 P2 JWT dotted command", config({ command: "server.mcp.js" })],
  ["verify3 P2 JWT dotted argument", config({ command: "node", args: ["server.mcp.js", "--version=1.2.3"] })],
);
for (const [position, server] of Object.entries(literalPositions)) {
  for (const [i, value] of [
    "eyJ1234567.abcdefghij.0123456789", // minimum segment lengths
    "eyJhbGciOiJIUzI1NiJ9.payload1234.signature12",
    "prefix eyJ1234567.abcdefghij.0123456789 suffix",
  ].entries()) {
    credentialMatrix.push([`verify3 P2 JWT ${i} in ${position}`, config(server(value)), /platform secrets/]);
  }
  for (const [i, value] of [
    "eyJ123456.abcdefghij.0123456789", "eyJ1234567.abcdefghi.0123456789", "eyJ1234567.abcdefghij.012345678",
    "abc1234567.abcdefghij.0123456789", "eyj1234567.abcdefghij.0123456789",
    "eyJ1234567.abcdefghij.0123456789.more", "more.eyJ1234567.abcdefghij.0123456789",
    "eyJ1234567.abcdefgh+j.0123456789", "eyJ1234567.abcdefghij.012345678=",
    "server.mcp.js", "--version=1.2.3",
  ].entries()) {
    credentialMatrix.push([`verify3 P2 non-JWT ${i} in ${position}`, config(server(value))]);
  }
}
for (const name of ["token-file", "api-key-file", "token-path", "secret-dir", "tokenFile", "API_KEY_PATH", "credentials.dir"]) {
  for (const position of ["assigned", "separate"]) {
    credentialMatrix.push([`verify3 P2 path ${position} ${name}`, config(positions[position](name, "./x"))]);
  }
}
for (const position of ["env", "header", "assigned", "separate"]) {
  for (const variable of ["api_key", "token", "aBc_123", "_secret", "sk_token", "tvp_token", "ghp_token"]) {
    for (const value of ["${" + variable + "}", "${" + variable + ":-}", "Bearer ${" + variable + "}"]) {
      credentialMatrix.push([`verify3 P2 lowercase ${position} ${value}`, config(positions[position]("API_KEY", value)), undefined, variable]);
    }
    for (const value of ["${" + variable + ":-DO_NOT_ECHO}", "${" + variable + "}\n", "${" + variable + "}${OTHER}"]) {
      credentialMatrix.push([`verify3 P2 malformed lowercase ${position} ${JSON.stringify(value)}`, config(positions[position]("API_KEY", value)), /platform secrets/]);
    }
  }
}

test("MCP credential positive and negative matrix (99a2230 + 27cb275 + review2 + verify3)", async (t) => {
  const f = fixture(t);
  for (const [label, input, reason, reference] of credentialMatrix) {
    await t.test(label, () => {
      if (reason) {
        const result = refuse(f, input, reason);
        assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_ECHO|sk-private|literal-secret|api_key=|session=/);
        if (reason.source.includes("platform secrets")) {
          assert.equal(result.stderr, "brain-write: MCP credentials must use platform secrets: store the value via platform secrets and reference it as ${VAR} or ${VAR:-} (empty default only)\n");
        }
      } else {
        const result = f.run(input);
        success(result, /Created|Updated|Unchanged/);
        assert.equal(fs.readFileSync(path.join(f.root, ".mcp.json"), "utf8"), canonical(input));
        assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_ECHO|private-default|Bearer|\$\{|https:/);
        if (reference) assert.match(result.stdout, new RegExp(`env references: ${reference}\n$`));
      }
    });
  }
});

for (const url of [
  "https://example.test/mcp?", "https://example.test/mcp#", "https://example.test/mcp#DO_NOT_ECHO",
  "https://user@example.test/mcp", "https://@example.test/mcp", "http://user:pass@localhost/mcp",
  "${URL}", "${URL:-https://example.test/mcp}",
]) {
  test(`refuses URL credentials, delimiters, or whole-URL references: ${url}`, (t) => {
    const result = refuse(fixture(t), config({ ...http, url }), /url/i);
    assert.doesNotMatch(result.stderr, /DO_NOT_ECHO|user:pass/);
  });
}

for (const input of [
  '{"mcpServers":{},"mcpServers":{"demo":{"command":"node"}}}',
  '{"mcpServers":{"demo":{"command":"node"},"demo":{"command":"node"}}}',
  '{"mcpServers":{"demo":{"command":"DO_NOT_ECHO","\\u0063ommand":"node"}}}',
  '{"mcpServers":{"demo":{"command":"node","env":{"KEY":"DO_NOT_ECHO","\\u004bEY":"${TOKEN}"}}}}',
  '{"mcpServers":{"demo":{"type":"http","url":"https://example.test","headers":{"Cookie":"DO_NOT_ECHO","Cookie":"${TOKEN}"}}}}',
  '{"mcpServers":{"demo":{"command":"node","extra":[{"x":0,"x":1}]}}}',
  '{"mcpServers":{"demo":{"command":"node","env":{"__proto__":"DO_NOT_ECHO","__proto__":"${TOKEN}"}}}}',
]) {
  test(`refuses duplicate decoded keys at every object depth: ${input}`, (t) => {
    const result = refuse(fixture(t), input, /duplicate object keys/);
    assert.doesNotMatch(result.stderr, /DO_NOT_ECHO/);
  });
}

test("canonicalizes escaped JSON and permits repeated keys in different objects", (t) => {
  const f = fixture(t);
  const input = JSON.stringify({ mcpServers: {
    one: { command: "node", args: ['{"x":1,"x":2}', '\\"[]{},\n'] },
    two: { command: "node" },
  } }).replace('"command"', '"\\u0063ommand"');
  success(f.run(input));
  assert.equal(fs.readFileSync(path.join(f.root, ".mcp.json"), "utf8"), canonical(input));
});

for (const field of ["command", "arg", "url"]) {
  for (const bytes of [4096, 4097]) {
    test(`${field} string has a UTF-8 byte cap: ${bytes}`, (t) => {
      const f = fixture(t);
      const prefix = field === "url" ? "https://example.test/" : "";
      const remaining = bytes - Buffer.byteLength(prefix);
      const value = prefix + "é".repeat(Math.floor(remaining / 2)) + (remaining % 2 ? "x" : "");
      const server = field === "url" ? { ...http, url: value } : field === "command" ? { command: value } : { command: "node", args: [value] };
      if (bytes === 4096) success(f.run(config(server)));
      else refuse(f, config(server), /4096-byte cap/);
    });
  }
}
test("caps server names and map keys before field validation", (t) => {
  const f = fixture(t);
  refuse(f, config(http, "x".repeat(4097)), /4096-byte cap/);
  refuse(f, config({ command: "node", env: { ["X".repeat(4097)]: "${TOKEN}" } }), /4096-byte cap/);
});

for (const bytes of [65536, 65537]) {
  test(`bounds the canonical file as well as the input: ${bytes} bytes`, (t) => {
    const f = fixture(t);
    const server = { command: "node", args: [...Array(15).fill("x".repeat(4096)), ""] };
    server.args[15] = "x".repeat(bytes - Buffer.byteLength(canonical(config(server))));
    const input = config(server);
    assert.ok(Buffer.byteLength(input) < 65536);
    assert.equal(Buffer.byteLength(canonical(input)), bytes);
    if (bytes === 65536) {
      success(f.run(input));
      assert.equal(fs.statSync(path.join(f.root, ".mcp.json")).size, bytes);
    } else refuse(f, input, /Canonical.*65536-byte/);
  });
}

// Fixed boundaries from poller #795's actual reminder format (3968 usable bytes).
// A single required variable of length 1954 makes a "demo" line 3967 bytes;
// one extra byte in the server name hits the limit, two exceeds it.
for (const name of ["demo", "demos", "demosx"]) {
  test(`checks the exact poller reminder boundary with required variables: ${name}`, (t) => {
    const f = fixture(t);
    const input = config({ command: "node", env: { KEY: "${" + "V".repeat(1954) + "}" } }, name);
    if (name === "demosx") refuse(f, input, /reminder budget/);
    else success(f.run(input));
  });
}
test("accounts for optional references once, required references twice, and deduplicates per server", (t) => {
  const f = fixture(t);
  const variable = "V".repeat(1955);
  const optional = "${" + variable + ":-}";
  success(f.run(config({ command: "node", args: [optional, optional], env: { KEY: optional } })));
  f.env[variable] = "available-to-writer";
  refuse(f, config({ command: "node", args: [optional], env: { KEY: "${" + variable + "}" } }), /reminder budget/);
});
test("budgets every line, including separators and the potentially longer none label", (t) => {
  const f = fixture(t);
  // 31 * 122 + 30 newlines = 3812 bytes. The last 155-byte line plus its
  // newline reaches 3968; making that name one byte longer must fail.
  const servers = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [
    String(i).padStart(62, "s"), { command: "node", args: ["${X}", "${X}"] },
  ]));
  servers["z".repeat(62)] = { command: "node", args: ["${" + "V".repeat(19) + "}"] };
  const last = Object.keys(servers).at(-1);
  const input = JSON.stringify({ mcpServers: servers });
  success(f.run(input));
  servers[last + "z"] = servers[last];
  delete servers[last];
  refuse(f, JSON.stringify({ mcpServers: servers }), /reminder budget/);
});

test("creates, updates atomically, and reports unchanged root .mcp.json", (t) => {
  const f = fixture(t);
  const target = path.join(f.root, ".mcp.json");
  const original = config();
  success(f.run(original));
  assert.equal(fs.readFileSync(target, "utf8"), canonical(original));
  fs.chmodSync(target, 0o640);
  const inode = fs.statSync(target).ino;
  const replacement = config(http, "sitebrew");
  const source = path.join(f.root, "input.json");
  fs.writeFileSync(source, replacement);
  success(f.run("ignored", [".mcp.json", "--from", source]), /Updated.*\n.*servers: sitebrew; env references: none/i);
  assert.notEqual(fs.statSync(target).ino, inode);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  const updatedInode = fs.statSync(target).ino;
  success(f.run("\n\t" + replacement + "  "), /Unchanged.*\n.*servers: sitebrew; env references: none/i);
  assert.equal(fs.statSync(target).ino, updatedInode);
  assert.equal(fs.readFileSync(target, "utf8"), canonical(replacement));
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
  { type: "stdio", command: "node", args: ["server.js", "${ARG}"], env: { MODE: "${MODE:-}", API_KEY: "${KEY}" } },
  http,
  { type: "sse", url: "https://example.test/sse", headers: { Authorization: "${TOKEN:-}", Accept: "text/event-stream" } },
  ...["localhost", "127.0.0.1", "[::1]"].map(host => ({ type: "http", url: `http://${host}:1234/mcp` })),
]) {
  test(`allows known transport ${JSON.stringify(server)}`, (t) => {
    const f = fixture(t);
    const content = config(server);
    success(f.run(content));
    assert.equal(fs.readFileSync(path.join(f.root, ".mcp.json"), "utf8"), canonical(content));
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
  ...["slack", "teamvibe-api", "teamvibe"].map(name => ["reserved " + name, config(http, name), /reserved.*base/]),
];
for (const [label, input, reason] of invalid) {
  test(`refuses ${label} without mutation`, (t) => {
    const result = refuse(fixture(t), input, reason);
    assert.doesNotMatch(result.stderr, /DO_NOT_ECHO|bad\nname/);
  });
}

for (const field of ["env", "headers"]) {
  for (const bytes of [4096, 4097]) {
    test(`${field} value ${bytes === 4096 ? "at" : "over"} 4 KiB boundary`, (t) => {
      const f = fixture(t);
      const server = field === "env" ? { command: "node" } : http;
      const value = field === "headers" ? "é".repeat(Math.floor(bytes / 2)) + (bytes % 2 ? "x" : "") : "${" + "V".repeat(bytes - 5) + ":-}";
      const input = config({ ...server, [field]: { [field === "headers" ? "Accept" : "OTHER"]: value } });
      if (bytes === 4096 && field === "headers") success(f.run(input));
      else if (bytes === 4096) refuse(f, input, /reminder budget/);
      else refuse(f, input, /4096-byte/);
    });
  }
}

test("reports all server names and deduplicated reference names across transport fields only", (t) => {
  const f = fixture(t);
  const result = f.run(JSON.stringify({ mcpServers: {
    zed: { ...http, url: "https://example.test/${HOST:-}", headers: { Authorization: "${TOKEN:-}", Other: "${TOKEN}" } },
    alpha: { command: "${EXEC:-}", args: ["${ARG:-}"], env: { API_KEY: "${TOKEN}" } },
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
      if (bytes === 65536) {
        success(f.run(input, args), /23 bytes/);
        assert.equal(fs.readFileSync(path.join(f.root, ".mcp.json"), "utf8"), canonical(input));
      }
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
