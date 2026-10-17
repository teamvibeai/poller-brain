import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../brain-skills.ts', import.meta.url));
const workspace = path.resolve(path.dirname(script), '../../..');
let suiteRoot;
before(() => { suiteRoot = fs.mkdtempSync(path.join(workspace, '.skill-tests-')); });
after(() => { if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true }); });
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function cmd(command, args, cwd, env = {}) {
  const r = spawnSync(command, args, { cwd, env: { ...process.env, DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', ...env }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `${command} ${args.join(' ')}\n${r.stderr}\n${r.stdout}`);
  return r.stdout.trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(suiteRoot, 'case-'));
  const upstream = path.join(root, 'upstream'), brain = path.join(root, 'brain'), bin = path.join(root, 'bin');
  for (const dir of [upstream, brain, bin]) fs.mkdirSync(dir);
  const git = (args, dir = upstream) => cmd('git', args, dir, { GIT_ALLOW_PROTOCOL: 'file' });
  for (const dir of [upstream, brain]) {
    git(['init', '-b', 'main'], dir); git(['config', 'user.name', 'Fixture'], dir); git(['config', 'user.email', 'fixture@example.test'], dir);
  }
  const skill = '---\nname: demo\ndescription: Fixture demo skill\n---\n\nOriginal\n';
  write(path.join(upstream, 'demo/SKILL.md'), skill);
  write(path.join(upstream, 'demo/scripts/helper.mjs'), 'console.log("fixture");\n');
  git(['add', '.']); git(['commit', '-m', 'initial']); git(['tag', 'v1']);
  const sha = git(['rev-parse', 'HEAD']);
  const source = 'https://fixture.invalid/upstream.git';
  // All remote-looking Git operations are rewritten into this local repo.
  // GIT_ALLOW_PROTOCOL=file blocks accidental real remotes. Node network calls
  // (including npm, security scans and telemetry) are blocked in every child.
  const deny = path.join(root, 'deny-network.cjs');
  write(deny, `for (const name of ['net','http','https','tls','dns']) { const mod = require('node:'+name); for (const key of ['connect','createConnection','request','get','lookup','resolve','resolve4','resolve6']) if (typeof mod[key] === 'function') mod[key] = () => { throw new Error('Network forbidden in tests: '+name+'.'+key); }; } globalThis.fetch = () => { throw new Error('Network forbidden in tests: fetch'); };\n`);
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    NODE_OPTIONS: `--require=${deny}`, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_update_notifier: 'false',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${upstream}.insteadOf`, GIT_CONFIG_VALUE_0: source, GIT_ALLOW_PROTOCOL: 'file',
    GH_CALL_LOG: path.join(root, 'gh.json'),
  };
  // Copy the JS-compatible .ts entrypoint so this suite works on Node 18+.
  const runner = path.join(root, 'brain-skills.mjs'); fs.copyFileSync(script, runner);
  write(path.join(brain, '.claude/skills/allowlist.yaml'), `sources:\n  - ${source}\n  - ${upstream}\n  - file://${upstream}\n`);
  const cli = (args, expected = 0) => {
    const r = spawnSync(process.execPath, [runner, ...args], { cwd: brain, env: { ...process.env, ...env, DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1' }, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, expected, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.stderr, '');
    const lines = r.stdout.trim().split('\n'); assert.equal(lines.length, 1, 'one JSON object');
    const value = JSON.parse(lines[0]); assert.equal(value.ok, expected === 0); assert.equal(expected === 0 ? value.error : value.data, null);
    return expected === 0 ? value.data : value.error;
  };
  const lockFile = path.join(brain, '.claude/skills/skills.lock.yaml');
  const readLock = () => JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const update = () => { write(path.join(upstream, 'demo/SKILL.md'), skill + 'Upstream update\n'); git(['add', '.']); git(['commit', '-m', 'update']); return git(['rev-parse', 'HEAD']); };
  const edit = () => write(path.join(brain, '.claude/skills/demo/SKILL.md'), skill + 'Local improvement\n');
  const add = () => cli(['add', `${source}#demo`]);
  const state = () => cli(['status', '--json']).entries.find(e => e.name === 'demo').state;
  const fakeGh = () => {
    write(path.join(bin, 'gh'), `#!/usr/bin/env node\nconst fs=require('node:fs'); if(process.env.DO_NOT_TRACK!=='1'||process.env.DISABLE_TELEMETRY!=='1')process.exit(9);fs.writeFileSync(process.env.GH_CALL_LOG, JSON.stringify({args:process.argv.slice(2),body:fs.readFileSync(process.argv[process.argv.indexOf('--body-file')+1],'utf8')}));console.log('https://github.example/fixture/upstream/pull/42');\n`);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
  };
  return { root, brain, upstream, source, sha, cli, git, add, state, update, edit, readLock, lockFile, fakeGh, env };
}

test('allowlisted local add delegates to real CLI and writes agreeing locks', () => {
  const f = fixture(), data = f.cli(['add', `${f.upstream}#demo`]);
  assert.equal(data.sha, f.sha); assert.equal(data.path, 'demo'); assert.equal(data.ref, 'main');
  assert.equal(data.source, fs.realpathSync(f.upstream)); assert.equal(data.upstream_pr, null);
  const tool = JSON.parse(fs.readFileSync(path.join(f.brain, 'skills-lock.json'), 'utf8'));
  assert.equal(tool.version, 1); assert.equal(tool.skills.demo.sourceType, 'local');
  assert.equal(tool.skills.demo.computedHash, data.content_hash);
  assert.equal(fs.readFileSync(path.join(f.brain, '.claude/skills/demo/SKILL.md'), 'utf8'), fs.readFileSync(path.join(f.upstream, 'demo/SKILL.md'), 'utf8'));
  f.cli(['lint']); assert.equal(f.state(), 'current');
});
test('file:// source is allowlisted and installed from its resolved SHA', () => {
  const f = fixture(); assert.equal(f.cli(['add', `file://${f.upstream}#demo`]).sha, f.sha); f.cli(['lint']);
});
test('non-allowlisted source refuses before invoking git or npx', () => {
  const f = fixture(); assert.match(f.cli(['add', 'other/repo#demo'], 1), /outside.*allowlist/);
  assert.equal(fs.existsSync(f.lockFile), false);
});
test('missing allowlist uses defaults and malformed policy fails closed', () => {
  const f = fixture(), file = path.join(f.brain, '.claude/skills/allowlist.yaml');
  fs.rmSync(file); assert.match(f.cli(['add', f.upstream], 1), /allowlist/);
  write(file, 'sources: nope\n'); assert.match(f.cli(['add', f.upstream], 1), /allowlist/);
});
test('native git URL #SHA pin ignores dirty files and supports a historical tag', () => {
  const f = fixture(); f.update(); write(path.join(f.upstream, 'demo/SKILL.md'), 'uncommitted and invalid\n');
  const data = f.cli(['add', `${f.source}#demo`, '--ref', 'v1']);
  assert.equal(data.sha, f.sha); assert.equal(f.state(), 'current');
  const tool = JSON.parse(fs.readFileSync(path.join(f.brain, 'skills-lock.json'), 'utf8')).skills.demo;
  assert.equal(tool.ref, f.sha); assert.equal(tool.skillPath, 'demo/SKILL.md'); f.cli(['lint']);
});
test('local historical ref is installed from a clean SHA snapshot', () => {
  const f = fixture(); f.update();
  assert.equal(f.cli(['add', `${f.upstream}#demo`, '--ref', 'v1']).sha, f.sha); f.cli(['lint']);
});
test('status current -> outdated -> modified; report has all counts and entries', () => {
  const f = fixture(); f.add(); assert.equal(f.state(), 'current');
  const sha = f.update(); assert.notEqual(sha, f.sha); assert.equal(f.state(), 'outdated');
  f.edit(); assert.equal(f.state(), 'modified');
  f.cli(['add', '--new', 'own-demo']);
  const report = f.cli(['report']); assert.equal(report.counts.modified, 1); assert.equal(report.counts.own, 1);
  assert.deepEqual(Object.keys(report.counts).sort(), ['current', 'outdated', 'modified', 'waiting-upstream', 'own', 'not-discovered'].sort());
  assert.equal(report.entries.length, 2);
});
test('sync refuses modifications, force updates SHA, locks and content', () => {
  const f = fixture(); f.add(); f.edit(); const sha = f.update();
  assert.match(f.cli(['sync', 'demo'], 1), /locally modified/);
  f.cli(['sync', 'demo', '--force']); assert.equal(f.readLock().skills.demo.sha, sha); assert.equal(f.state(), 'current'); f.cli(['lint']);
});
test('sync re-vendors a pure upstream SHA bump', () => {
  const f = fixture(); f.add(); f.update(); f.cli(['sync']); assert.equal(f.state(), 'current'); f.cli(['lint']);
});
test('ensure is idempotent, preserves a local edit, and restores missing files', () => {
  const f = fixture(); assert.equal(f.cli(['ensure', 'demo', `${f.source}#demo`, '--ref', 'main']).changed, true);
  const before = fs.readFileSync(f.lockFile, 'utf8'); f.edit();
  assert.equal(f.cli(['ensure', 'demo', `${f.source}#demo`]).changed, false);
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), before); assert.equal(f.state(), 'modified');
  fs.rmSync(path.join(f.brain, '.claude/skills/demo'), { recursive: true });
  assert.equal(f.cli(['ensure', 'demo', `${f.source}#demo`]).changed, true); assert.equal(f.state(), 'current');
});
test('new skill is own, scaffolded flat and has no provenance', () => {
  const f = fixture(); f.cli(['add', '--new', 'work-management']);
  assert.equal(fs.existsSync(f.lockFile), false); assert.equal(f.cli(['status']).entries[0].state, 'own'); f.cli(['lint']);
  assert.match(f.cli(['add', '--new', '../escape'], 1), /Invalid skill name/);
});
test('push applies additions, edits and deletions at locked SHA and records fake gh PR', () => {
  const f = fixture(); f.add(); f.edit(); f.fakeGh();
  fs.rmSync(path.join(f.brain, '.claude/skills/demo/scripts/helper.mjs'));
  write(path.join(f.brain, '.claude/skills/demo/extra.md'), 'New file\n');
  const result = f.cli(['push', 'demo']);
  assert.equal(result.upstream_pr, 'https://github.example/fixture/upstream/pull/42'); assert.equal(f.state(), 'waiting-upstream');
  assert.equal(f.git(['rev-parse', `${result.branch}^`]), f.sha);
  assert.match(f.git(['show', `${result.branch}:demo/SKILL.md`]), /Local improvement/);
  assert.equal(f.git(['show', `${result.branch}:demo/extra.md`]), 'New file');
  assert.equal(f.git(['ls-tree', '-r', '--name-only', result.branch]).includes('helper.mjs'), false);
  const gh = JSON.parse(fs.readFileSync(f.env.GH_CALL_LOG, 'utf8')); assert.deepEqual(gh.args.slice(0, 2), ['pr', 'create']); assert.match(gh.body, new RegExp(f.sha));
  f.cli(['lint']); assert.equal(f.cli(['push', 'demo']).changed, false);
  f.cli(['sync', 'demo']); assert.equal(f.readLock().skills.demo.upstream_pr, null); assert.equal(f.state(), 'current');
});
test('push without changes refuses and does not create a PR', () => {
  const f = fixture(); f.add(); assert.match(f.cli(['push', 'demo'], 1), /no vendored changes/);
});
test('lint flags nested skills and report marks them not-discovered', () => {
  const f = fixture(); write(path.join(f.brain, '.claude/skills/shared/demo/SKILL.md'), '---\nname: demo\ndescription: Nested\n---\n');
  assert.match(f.cli(['lint'], 1), /Nested skill/); assert.equal(f.cli(['report']).counts['not-discovered'], 1);
});
test('lint flags duplicate name and directory/name mismatch', () => {
  const f = fixture(); f.cli(['add', '--new', 'demo']); write(path.join(f.brain, '.claude/skills/other/SKILL.md'), '---\nname: demo\ndescription: Duplicate\n---\n');
  const error = f.cli(['lint'], 1); assert.match(error, /Duplicate/); assert.match(error, /mismatch/);
});
test('lint requires description and rejects malformed/duplicate frontmatter', () => {
  const f = fixture(), file = path.join(f.brain, '.claude/skills/demo/SKILL.md');
  write(file, '---\nname: demo\n---\n'); assert.match(f.cli(['lint'], 1), /Missing description/);
  write(file, '---\nname: demo\ndescription: "unclosed\n---\n'); assert.match(f.cli(['lint'], 1), /Invalid/);
  write(file, '---\nname: demo\nname: demo\ndescription: Duplicate key\n---\n'); assert.match(f.cli(['lint'], 1), /duplicate/);
});
test('lint supports multiline description and requires referenced scripts', () => {
  const f = fixture(), file = path.join(f.brain, '.claude/skills/demo/SKILL.md');
  write(file, '---\nname: demo\ndescription: |\n  Multi-line description.\n  Use for tests.\n---\nRun `npx tsx scripts/missing.ts`.\n');
  assert.match(f.cli(['lint'], 1), /Missing referenced script/); write(path.join(path.dirname(file), 'scripts/missing.ts'), '// Exists\n'); f.cli(['lint']);
});
test('lint detects local content hash drift and both-lock hash/source drift', () => {
  const f = fixture(); f.add(); f.edit(); assert.match(f.cli(['lint'], 1), /Content hash drift/);
  f.cli(['sync', '--force']); const file = path.join(f.brain, 'skills-lock.json');
  const tool = JSON.parse(fs.readFileSync(file, 'utf8')); tool.skills.demo.computedHash = '0'.repeat(64); write(file, JSON.stringify(tool));
  assert.match(f.cli(['lint'], 1), /Two-lock hash drift/);
  tool.skills.demo.computedHash = f.readLock().skills.demo.content_hash; tool.skills.demo.source = 'tampered'; write(file, JSON.stringify(tool));
  assert.match(f.cli(['lint'], 1), /source\/ref\/path drift/);
  tool.skills.demo.source = f.source; write(file, JSON.stringify(tool));
  const provenance = f.readLock(); provenance.skills.demo.source = 'https://other.invalid/repo.git'; write(f.lockFile, JSON.stringify(provenance));
  assert.match(f.cli(['lint'], 1), /provenance drift/);
});
test('ref/path traversal, unknown flags and accidental add overwrite refuse', () => {
  const f = fixture(); assert.match(f.cli(['add', `${f.source}#../demo`], 1), /Unsafe skill path/);
  assert.match(f.cli(['add', f.source, '--ref', 'missing'], 1), /not advertised/);
  assert.match(f.cli(['status', '--force'], 1), /not valid/);
  f.add(); assert.match(f.cli(['add', `${f.source}#demo`], 1), /already exists/);
});
test('sync still enforces allowlist after policy changes', () => {
  const f = fixture(); f.add(); write(path.join(f.brain, '.claude/skills/allowlist.yaml'), 'sources: []\n'); assert.match(f.cli(['sync'], 1), /allowlist/);
});
test('failed CLI installation restores existing content and both locks', () => {
  const f = fixture(); f.add(); f.update(); const before = fs.readFileSync(f.lockFile, 'utf8');
  const toolBefore = fs.readFileSync(path.join(f.brain, 'skills-lock.json'), 'utf8');
  const bin = path.join(f.root, 'bin/npx');
  write(bin, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("skills-lock.json", "{}");process.exit(1);\n'); fs.chmodSync(bin, 0o755);
  assert.match(f.cli(['sync'], 1), /npx failed/); assert.equal(fs.readFileSync(f.lockFile, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.brain, 'skills-lock.json'), 'utf8'), toolBefore);
  assert.equal(f.state(), 'outdated');
});
test('name selection supports a root SKILL.md and source metadata order is immaterial', () => {
  const f = fixture();
  fs.renameSync(path.join(f.upstream, 'demo/SKILL.md'), path.join(f.upstream, 'SKILL.md'));
  fs.renameSync(path.join(f.upstream, 'demo/scripts'), path.join(f.upstream, 'scripts'));
  fs.rmdirSync(path.join(f.upstream, 'demo')); f.git(['add', '.']); f.git(['commit', '-m', 'root skill']);
  assert.equal(f.cli(['add', f.source, '--name', 'demo']).path, '.');
  const file = path.join(f.brain, 'skills-lock.json'), tool = JSON.parse(fs.readFileSync(file, 'utf8'));
  tool.skills.demo = Object.fromEntries(Object.entries(tool.skills.demo).reverse()); write(file, JSON.stringify(tool));
  f.cli(['lint']); assert.equal(f.state(), 'current');
});
test('annotated tags resolve to commit SHA rather than tag object', () => {
  const f = fixture(); f.git(['tag', '-a', 'annotated', '-m', 'annotated tag']); f.update();
  assert.equal(f.cli(['add', `${f.source}#demo`, '--ref', 'refs/tags/annotated']).sha, f.sha); f.cli(['lint']);
});
test('lint detects a tool-only lock entry and missing vendored files', () => {
  const f = fixture(); f.add(); fs.rmSync(path.join(f.brain, '.claude/skills/demo'), { recursive: true });
  assert.equal(f.state(), 'modified'); assert.match(f.cli(['lint'], 1), /Missing skill directory/);
  f.cli(['ensure', 'demo', `${f.source}#demo`]);
  const value = f.readLock(); delete value.skills.demo; write(f.lockFile, JSON.stringify(value));
  assert.match(f.cli(['lint'], 1), /no provenance/);
});
test('wrapper refuses a symlinked skills directory', () => {
  const f = fixture(); fs.renameSync(path.join(f.brain, '.claude/skills'), path.join(f.root, 'outside'));
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.brain, '.claude/skills'));
  assert.match(f.cli(['add', '--new', 'escape'], 1), /symlink/);
  assert.equal(fs.existsSync(path.join(f.root, 'outside/escape')), false);
});
