// Round-two disclosure and worker-resource regressions. Run with plain Node 22.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets } from "../lib/bash-telemetry-redact.mjs";
import { prepareBashTelemetryHook } from "../lib/bash-telemetry-core.mjs";
import { simpleCommands } from "../lib/shell-tokenizer.mjs";

const TOKEN = "tvp_ConfiguredCanarySecretValue";
const env = { TEAMVIBE_API_URL: "http://fixture.invalid", TEAMVIBE_POLLER_TOKEN: TOKEN,
  TEAMVIBE_CHANNEL_ID: "fixture-channel" };
const input = command => ({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp" });
const decode = command => simpleCommands(command, { allowEnvReferences: true, stripSudo: false })
  .flatMap(({ words }) => words).join(" ");

test("#585 bracket paths and all six reported commands survive byte-for-byte", () => {
  const commands = [
    "git ls-files 'src/file[ab].ts'",
    "git log --format=%h -- src/file[ab].ts",
    "npm run test -- --testPathPattern=hooks/lib/file[ab].mjs",
    "git log -p HEAD~1..HEAD",
    "curl -p --proxy http://localhost:8080 https://example.invalid",
    "npm run test -- --passWithNoTests=true",
    'git ls-files "src/file[ab].ts"',
    "git ls-files src/file[ab].ts",
    "git ls-files src/fi''le[ab].ts",
    "git ls-files src/file[ab]=value.ts",
    "git ls-files 'file[ab].ts=value'",
    "git ls-files 'file[ab].ts' 'file[cd]=value.ts'",
    "git ls-files 'file[ab].ts=TOKEN[1 + 2].ts'",
    "echo file[ab].ts && git status",
    "git ls-files src/file[ab].ts; curl -p --proxy http://localhost:8080",
    "echo " + "file[ab].ts ".repeat(4000),
    "echo " + "--".repeat(30000),
    "echo " + "a[".repeat(20000),
  ];
  for (const command of commands) assert.equal(redactSecrets(command), command);
  console.log(`#585 unchanged commands=${commands.length}`);
});

test("#585 short -p exceptions use only resolved curl and git log contexts", () => {
  const commands = [
    "git log -pHEAD~1..HEAD",
    "git log -p $REF", "curl -p$REF", "git log -p HEAD -- src/file[ab].ts",
    "MODE=plain git log -p HEAD", "sudo git log -p HEAD",
    "command curl -p --proxy http://localhost:8080", "env MODE=plain curl -p --proxy localhost",
    "git -C /project log -p HEAD", "git --no-pager log -p HEAD",
    "git log -p HEAD && mysql -p $REF", "curl -p --proxy localhost; git log -pHEAD",
    "curl --proxy http://localhost:8080 -p https://example.invalid",
    "curl --user $REF -p --proxy localhost",
  ];
  for (const command of commands) assert.equal(redactSecrets(command), command);
  console.log(`#585 nonsecret -p commands=${commands.length}`);
});

test("#585 full boolean option names precede generic sensitive-name matching", () => {
  let checks = 0;
  for (const name of ["--passWithNoTests", "--pass-with-no-tests"]) {
    for (const value of ["true", "false", '"true"', "tr''ue", "$REF", "${REF}"]) {
      const command = `npm run test -- ${name}=${value}`;
      assert.equal(redactSecrets(command), command);
      checks++;
    }
  }
  console.log(`#585 nonsecret option checks=${checks}`);
});

test("#585 exceptions retain credential protection and omit uncertain assignment extents", () => {
  let checks = 0;
  const protectedCommands = [
    "mysql -p CanaryPassword", "mysql -pCanaryPassword", "unknown -p CanaryPassword",
    "unknown -pCanaryPassword", "git status -p CanaryPassword", "git status -pCanaryPassword",
    "npm run test -- -p CanaryPassword", "npm run test -- -pCanaryPassword",
    "wrapper git log -p CanaryPassword", "git -c alias.log=mysql log -p CanaryPassword",
    "sudo -u root curl -p CanaryPassword", "env -S 'curl -p CanaryPassword'",
    "echo curl git log -p CanaryPassword", "curl -p --password CanaryPassword",
    "git log -p HEAD && mysql -pCanaryPassword", "mysql -pCanaryPassword; curl -p --proxy localhost",
    "curl -p 'outer=plain TOKEN=CanaryNested'", "git log -p '--password=CanaryNested'",
    "npm run test -- --passWithNoTests=CanaryPassword", "npm --passWithNoTests=trueCanaryTail",
    "npm --passWithNoTests=$REF-CanaryTail", "npm --pass-with-no-tests=${REF}CanaryTail",
    "npm --custom-api-key=CanaryPassword", "npm --monkey=CanaryPassword",
    "npm --custom-passWithNoTests=trueCanaryTail", "BYPASS=CanaryPassword npm test",
    "declare passWithNoTests=CanaryPassword", "echo 'outer=plain --custom-token=CanaryNested'",
    "echo 'nested:TOKEN[1 + 2]=CanaryAssignment trailingCanary'",
    "echo 'nested:TOKEN[1 + 2]+=CanaryAssignment trailingCanary'",
    "TOKEN['a]b']='CanaryAssignment trailingCanary'",
    "declare -A TOKEN[1 + 'a] b']='CanaryAssignment trailingCanary'",
    "curl -p -H 'Authorization: Basic CanaryHeader trailingCanary'",
    "git log -p -H 'Cookie: CanaryHeader trailingCanary'",
    "npm --passWithNoTests='Authorization: Bearer CanaryHeader trailingCanary'",
    "git log -p xoxb-CanarySignature", "curl -pxoxb-CanarySignature",
    "npm --passWithNoTests=xoxb-CanarySignature",
    "git log -p $REF-CanaryTail", "curl -p${REF}CanaryTail",
    "echo src/file[ab].ts --token CanaryPassword",
    "npm --passWithNoTests=true --token CanaryPassword",
    'git log -p "-----BE""GIN PRIVATE KEY----- CanaryPem"',
    "curl -p '-----BEGIN PRIVATE KEY----- CanaryPem'",
  ];
  for (const prefix of ["", "export ", "declare -a ", "local ", "readonly ", "echo 'outer=plain "]) {
    for (const assignment of ["TOKEN[0]=", "PASSWORD+=", "TOKEN[i]+=", "TOKEN[1 + 2]=", "TOKEN[1 + 2]+=", "TOKEN[a[0]]="]) {
      protectedCommands.push(`${prefix}${assignment}\"CanaryAssignment trailingCanary\"${prefix.startsWith("echo") ? "'" : ""}`);
    }
  }
  for (const command of protectedCommands) {
    const result = redactSecrets(command);
    assert.ok(!/Canary/.test(result), `${command}: ${result}`);
    assert.match(result, /\[REDACTED/);
    checks++;
  }
  for (const signature of ["AKIAABCDEFGHIJKLMNOP", "ASIAABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_abcdefghijklmnopqrstuv012345", "xoxb-CanarySignature"]) {
    for (const prefix of ["git log -p ", "git log -p", "curl -p ", "curl -p", "npm --passWithNoTests="]) {
      assert.ok(!redactSecrets(prefix + signature).includes(signature));
      checks++;
    }
  }
  for (const command of ["git log -p " + TOKEN, "curl -p" + TOKEN,
    "npm --passWithNoTests=true", "npm --pass-with-no-tests=false"]) {
    const knownTokens = command.includes(TOKEN) ? [TOKEN] : [command.endsWith("true") ? "true" : "false"];
    assert.match(redactSecrets(command, { knownTokens }), /\[REDACTED/);
    checks++;
  }
  for (const command of ["npm --passWithNoTests+=true", "npm --passWithNoTests[0]=true",
    "npm --pass-with-no-tests+=false", "npm --custom-passWithNoTests=true",
    "passWithNoTests=true", "declare passWithNoTests=true", "BYPASS=true"]) {
    assert.match(redactSecrets(command), /\[REDACTED/);
    checks++;
  }
  assert.equal(redactSecrets("echo keep && TOKEN[1 + 2]='CanaryAssignment trailingCanary'; git status"),
    "echo keep && [REDACTED] ; git status");
  assert.equal(redactSecrets("echo src/file[ab].ts --token CanaryPassword"), "echo src/file[ab].ts --token [REDACTED]");
  console.log(`#585 protection checks=${checks + 2}`);
});

// Review1: decoded subscripts and option arguments must never widen exemptions.
const review1Commands = {
  arrays: [
    "declare -A TOKEN; TOKEN['public[0']='CanaryPassword trailingCanary'",
    "declare -A TOKEN; TOKEN['public[0']+='CanaryPassword trailingCanary'",
    "declare -A TOKEN; TOKEN['public[0']=$REF-CanaryPassword",
    "TOKEN[0]=$REF TOKEN['public[0']='CanaryPassword trailingCanary'",
    "TOKEN['outer[inner[0']='CanaryPassword trailingCanary'",
  ],
  optionValues: [
    "curl --user '-p:CanaryPassword' https://example.invalid",
    "curl --proxy-user '-p:CanaryPassword' https://example.invalid",
    "curl -u '-p:CanaryPassword' https://example.invalid",
    "curl -U '-p:CanaryPassword' https://example.invalid",
    "curl -p --user '-p:CanaryPassword' https://example.invalid",
    "curl --proxy localhost --proxy-user '-p:CanaryPassword' https://example.invalid",
    "curl --unknown '-p:CanaryPassword' https://example.invalid",
    "curl -- '-p:CanaryPassword'",
    "curl --data '-p CanaryPassword trailingCanary'",
    "curl '-p CanaryPassword trailingCanary'",
  ],
};
for (const [kind, commands] of Object.entries(review1Commands)) {
  test(`#585 review1 ${kind}: redact direct output and telemetry metadata`, () => {
    for (const command of commands) {
      const { event } = prepareBashTelemetryHook(input(command), env);
      assert.ok(event);
      for (const result of [redactSecrets(command), event.metadata.command]) {
        assert.ok(!/Canary/.test(result), `${command}: ${result}`);
        assert.match(result, /\[REDACTED/);
      }
    }
    console.log(`#585 review1 ${kind} checks=${commands.length * 2}`);
  });
}

function protectBoth(command) {
  const { event } = prepareBashTelemetryHook(input(command), env);
  assert.ok(event);
  for (const result of [redactSecrets(command), event.metadata.command]) {
    assert.ok(!/Canary/.test(result), `${command}: ${result}`);
    assert.match(result, /\[REDACTED/);
  }
}

test("#585 review2 curl bundles consume attached/separate credential arguments", { timeout: 5000 }, () => {
  let commands = 0;
  // Enumerate all placements of p and other no-value flags before u/U.
  // Anything after u/U is its attached argument, even another flag letter.
  const prefixes = new Set(["", "p", "ps", "sp", "pIs", "sIp", "IpS"]);
  for (const flag of ["s", "I", "L", "k", "v", "g", "N", "4", "6"]) {
    prefixes.add(`p${flag}`);
    prefixes.add(`${flag}p`);
  }
  for (const prefix of prefixes) for (const credential of ["u", "U"]) {
    for (const value of [" '-p:CanaryPassword trailingCanary'", "-p:CanaryPassword", " CanaryPassword"]) {
      protectBoth(`curl -${prefix}${credential}${value} https://example.invalid`);
      commands++;
    }
    // u/U first: the following p belongs to the credential value.
    protectBoth(`curl -${credential}${prefix}CanaryPassword https://example.invalid`);
    commands++;
  }
  const uncertainCommands = ["curl --data -- -pu CanaryPassword", "curl --data -X -pU CanaryPassword",
    "curl --unknown -H -puCanaryPassword", "curl --unknown -H --user CanaryPassword"];
  for (const command of ["curl -px '-p:CanaryPassword'", "curl -pX '-p:CanaryPassword'",
    "curl -phttp://CanaryPassword", "curl https://example.invalid -spu CanaryPassword",
    "curl --user=CanaryPassword", "curl --proxy-user=-p:CanaryPassword", ...uncertainCommands]) {
    protectBoth(command);
    commands++;
  }
  for (const command of ["curl -sIp --proxy localhost https://example.invalid", "curl -p -u $REF",
    "curl -p -sU ${REF}", "curl -x localhost -p https://example.invalid"]) {
    assert.equal(redactSecrets(command), command);
    assert.equal(prepareBashTelemetryHook(input(command), env).event.metadata.command, command);
  }
  console.log(`#585 review2 curl matrix commands=${commands}, paths=2`);
});

test("#585 review2 indexed assignment depths, punctuation, quotes and uncertainty", { timeout: 5000 }, () => {
  let commands = 0;
  for (const punctuation of ["", "nested-", "nested.", "nested/", "nested:"]) {
    for (const depth of [0, 1, 2, 4, 16]) for (const operator of ["=", "+="]) {
      const index = "a[".repeat(depth) + "1 + 2" + "]".repeat(depth);
      protectBoth(`echo '${punctuation}TOKEN[${index}]${operator}CanaryPassword trailingCanary'`);
      commands++;
    }
  }
  for (const index of ["a b", "a[0]", "a[0", "a]b", '"a]b"', '"a[b"', "'a]b'", "[broken", "broken"]) {
    for (const operator of ["=", "+="]) {
      protectBoth(`echo 'nested-TOKEN[${index}]${operator}CanaryPassword trailingCanary'`);
      commands++;
    }
  }
  for (const command of ["TOKEN[broken=CanaryPassword", "TOKEN[broken+=CanaryPassword",
    "TOKEN[0][1]+=CanaryPassword", "TOKEN[0]=$REF TOKEN[a[0]]=CanaryPassword"]) {
    protectBoth(command);
    commands++;
  }
  console.log(`#585 review2 assignment matrix commands=${commands}, paths=2`);
});

test("#585 review2 scanner stress stays bounded at telemetry's input limit", { timeout: 5000 }, () => {
  const start = performance.now();
  let worst = 0;
  for (const size of [16000, 32000, 64000]) {
    for (const part of ["KEY", "--", "a[", "long-label-", "a=", "a-", "'a[", "a[0]."]) {
      const command = "echo " + part.repeat(Math.floor(size / part.length));
      const before = performance.now();
      redactSecrets(command);
      worst = Math.max(worst, performance.now() - before);
    }
    protectBoth("echo 'TOKEN[" + "a[".repeat(size / 4) + "]=" + "CanaryPassword'");
  }
  assert.ok(performance.now() - start < 3000, "matrix exceeded three seconds");
  assert.ok(worst < 1000, `individual input took ${worst}ms`);
  console.log(`#585 review2 stress worst_ms=${worst.toFixed(2)}`);
});

test("#585 bracket cwd and benign commands survive telemetry preparation", () => {
  let checks = 0;
  for (const cwd of ["/project/src/file[ab]", "/project/file[ab]=value", "/project/fi''le[ab]"]) {
    const command = "git ls-files 'src/file[ab].ts' && npm test -- --passWithNoTests=true";
    const { event } = prepareBashTelemetryHook({ ...input(command), cwd }, env);
    assert.equal(event.metadata.cwd, cwd);
    assert.equal(event.metadata.command, command);
    checks += 2;
  }
  const { event } = prepareBashTelemetryHook({ ...input("git log -p HEAD"), cwd: `/project/file[ab]/${TOKEN}` }, env);
  assert.ok(!event.metadata.cwd.includes(TOKEN));
  console.log(`#585 metadata checks=${checks + 1}`);
});

test("credential headers redact every scheme and the complete quoted/multiline value", () => {
  let checks = 0;
  for (const header of ["Authorization: Basic", "Authorization: token", "Authorization: CustomScheme",
    "Proxy-Authorization: Basic", "X-Api-Key:", "X-Service-Token:", "X-Service-Secret:", "Cookie:"]) {
    for (const value of ["CanaryHeaderSecret", "CanaryHeaderSecret trailingCanary", "CanaryHeaderSecret\ntrailingCanary"]) {
      for (const command of [`curl -H '${header} ${value}' https://example.invalid`, `${header} '${value}'`]) {
        const output = redactSecrets(command);
        assert.ok(!/Canary/.test(output), `${command}: ${output}`);
        checks++;
      }
    }
    for (const reference of ["$REF", "${REF}"]) {
      const command = `curl -H '${header} ${reference}'`;
      assert.equal(redactSecrets(command), command, "whole variable reference must survive");
      checks++;
    }
  }
  for (const command of [
    `curl -H'Authorization: Basic CanaryAttached'`,
    `curl --header='pRoXy-AuThOrIzAtIoN: Custom CanaryMixedCase'`,
    `curl -H 'X-Public: yes\nCookie: CanaryCookie; tail=trailingCanary'`,
    `curl -H 'Authorization: Basic $REF trailingCanary'`,
    `curl -H 'X-Api-Key: $REF-trailingCanary'`,
    `curl -H 'X-Secret: firstCanary' -H 'Cookie: trailingCanary'`,
  ]) {
    assert.ok(!/Canary/.test(redactSecrets(command)), command);
    checks++;
  }
  for (const command of [
    `Authorization: Basic "$REF"`, `Proxy-Authorization: CustomScheme ${"${REF}"}`,
    `X-Api-Key: "$REF"`, `Cookie: '${"${REF}"}'`,
    `curl -H'Authorization: Basic $REF' https://example.invalid`,
    `curl -H 'Accept: application/json'`,
    "echo " + "long-label-".repeat(6000),
  ]) {
    assert.equal(redactSecrets(command), command);
    checks++;
  }
  console.log(`header checks=${checks}`);
});

test("append/indexed assignments redact the complete value, including declaration forms", () => {
  let checks = 0;
  for (const prefix of ["", "export ", "declare ", "declare -a ", "local ", "readonly "]) {
    for (const assignment of ["PASSWORD+=", "TOKEN[0]=", "TOKEN[i]+=", "TOKEN[123]="]) {
      for (const value of ["CanaryAssignmentSecret", "'CanaryAssignmentSecret trailingCanary'", '"CanaryAssignmentSecret\ntrailingCanary"']) {
        const command = `${prefix}${assignment}${value}`;
        assert.ok(!/Canary/.test(redactSecrets(command)), command);
        checks++;
      }
      for (const reference of ["$REF", "${REF}"]) {
        const command = `${prefix}${assignment}${reference}`;
        assert.equal(redactSecrets(command), command);
        checks++;
      }
    }
  }
  for (const command of ["TOKEN[$(printf 0)]=CanaryUnsupported", "TOKEN=(CanaryUnsupported moreCanary)",
    "TOKEN[${INDEX:-0}]+=CanaryUnsupported", "TOKEN[1 + 2]='CanaryUnsupported moreCanary'",
    "declare -A TOKEN=([name]='CanaryUnsupported moreCanary')"]) {
    assert.ok(!/Canary/.test(redactSecrets(command)), command);
    checks++;
  }
  console.log(`assignment checks=${checks}`);
});

test("configured credentials are masked on decoded words, including substrings and cwd", () => {
  let checks = 0;
  for (const value of [TOKEN, "tvp_ConfiguredCanary'SecretValue'", String.raw`tvp_ConfiguredCanarySecret\Value`,
    '"tvp_Configured"CanarySecretValue', "prefix-tvp_ConfiguredCanary'SecretValue'-suffix"]) {
    for (const field of ["command", "cwd"]) {
      const payload = input(`echo ${value}`);
      if (field === "cwd") payload.cwd = `/tmp/${value}`;
      const { event } = prepareBashTelemetryHook(payload, env);
      assert.ok(event);
      assert.ok(!decode(event.metadata[field]).includes(TOKEN), `${field}: ${event.metadata[field]}`);
      assert.ok(!/ConfiguredCanary|SecretValue/.test(event.metadata[field]), "omit the entire matching word");
      checks++;
    }
  }
  console.log(`known-token checks=${checks}`);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 5000) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < ms, "deadline waiting for delivery/worker exit");
    await delay(10);
  }
}

test("stalled bursts cap workers at four; stale slots and spawn failures recover silently", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bash-telemetry-burst-"));
  const log = join(dir, "spawns.jsonl");
  const preload = join(dir, "inspect.mjs");
  writeFileSync(log, "");
  writeFileSync(preload, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
if (process.argv[1]?.endsWith('/hooks/bash-telemetry.mjs')) {
  const original = cp.spawn;
  cp.spawn = (executable, args, options) => {
    if (process.env.BURST_SPAWN_MODE === 'throw') throw new Error('fixture spawn failure');
    if (process.env.BURST_SPAWN_MODE === 'async-error') executable += '.nonexistent';
    const child = original(executable, args, options);
    if (child.pid) appendFileSync(process.env.BURST_LOG, JSON.stringify({pid: child.pid}) + '\\n');
    return child;
  };
  syncBuiltinESMExports();
}
`);
  const pids = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).pid);
  const alive = () => pids().filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  let requests = 0, stalled = true;
  const server = createServer((req, res) => {
    req.resume(); req.on("end", () => { requests++; if (!stalled) { res.writeHead(204); res.end(); } });
  });
  t.after(() => {
    server.closeAllConnections(); server.close();
    for (const pid of alive()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const childEnv = { PATH: process.env.PATH, TMPDIR: dir, BURST_LOG: log,
    NODE_OPTIONS: `--import ${pathToFileURL(preload)}`, ...env,
    TEAMVIBE_API_URL: `http://127.0.0.1:${server.address().port}` };
  const hook = fileURLToPath(new URL("../bash-telemetry.mjs", import.meta.url));
  let maxWorkers = 0;
  const sampler = setInterval(() => { maxWorkers = Math.max(maxWorkers, alive().length); }, 5);
  t.after(() => clearInterval(sampler));
  const latencies = [];
  async function invokeOne(i, extra = {}) {
    const start = Date.now();
    const child = spawn(process.execPath, [hook], { env: { ...childEnv, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    child.stdin.end(JSON.stringify(input(`echo burst-${i}`)));
    assert.deepEqual(await done, { code: 0, signal: null, stdout: "", stderr: "" });
    latencies.push(Date.now() - start);
  }

  // A recently dead parent could have orphaned a worker before PID handoff.
  // Fresh reservations stay occupied; aged reservations and abandoned staging
  // directories are reclaimed without waiting on the hook path.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  const root = join(dir, `teamvibe-bash-telemetry-${process.getuid?.() ?? "user"}`);
  const owner = `pending-${deadPid}-12345678-abcd`;
  for (let i = 0; i < 4; i++) {
    const slot = join(root, `slot-${i}`);
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, owner), "");
  }
  await invokeOne("fresh-pending");
  assert.equal(pids().length, 0);
  for (let i = 0; i < 4; i++) utimesSync(join(root, `slot-${i}`, owner), 0, 0);
  const abandoned = join(root, `claim-${deadPid}-12345678-abcd`);
  mkdirSync(abandoned);
  utimesSync(abandoned, 0, 0);
  for (const burst of ["sequential", "parallel"]) {
    const before = requests;
    if (burst === "sequential") {
      for (let i = 0; i < 30; i++) await invokeOne(i);
    } else {
      await Promise.all(Array.from({ length: 30 }, (_, i) => invokeOne(i)));
    }
    await until(() => alive().length === 0);
    assert.ok(maxWorkers <= 4, `maximum concurrent workers: ${maxWorkers}`);
    assert.ok(requests > before && requests < before + 30, `delivered ${requests - before}; saturation must drop events`);
    console.log(`${burst} burst: calls=30, posts=${requests - before}, maxWorkers=${maxWorkers}, remainingWorkers=0`);
  }
  assert.equal(existsSync(abandoned), false);
  assert.equal(requests, pids().length, "each admitted invocation sends exactly once");
  const before = requests;
  for (const mode of ["throw", "async-error"]) await invokeOne(mode, { BURST_SPAWN_MODE: mode });
  assert.equal(pids().length, before, "spawn failures must not start delivery workers");
  stalled = false;
  await invokeOne("recovery");
  await until(() => requests === before + 1 && alive().length === 0);
  assert.ok(Math.max(...latencies) < 750, `maximum hook latency: ${Math.max(...latencies)}ms`);
  console.log(`capacity recovery: calls=64, posts=${requests}, spawnFailures=2, freshPendingDrops=1, maxWorkers=${maxWorkers}, maxHookMs=${Math.max(...latencies)}, remainingWorkers=0`);
});
