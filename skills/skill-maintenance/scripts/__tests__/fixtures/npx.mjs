#!/usr/bin/env node
// Local installer double: exercise the wrapper's subprocess contract without npm.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const [, , , input, , name] = args;
assert.deepEqual(args, ['-y', 'skills@1.7.2', 'add', input, '--skill', name, '--full-depth', '-y', '--json', '--agent', 'claude-code']);
assert.equal(process.env.DO_NOT_TRACK, '1');
assert.equal(process.env.DISABLE_TELEMETRY, '1');
fs.appendFileSync(process.env.INSTALL_CALL_LOG, JSON.stringify(args) + '\n');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remote = /^(https:|ssh:|git@)/.test(input);
const temp = fs.mkdtempSync(path.join(process.cwd(), '.fake-installer-'));
try {
  let repo = input, ref, source = input;
  if (remote) {
    [source, ref] = input.split('#');
    assert.match(ref, /^[a-f0-9]{40}$/);
    repo = path.join(temp, 'upstream');
    git(['clone', '--no-checkout', '--', source, repo]);
    git(['checkout', '--detach', ref], repo);
  }
  const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['.git', 'node_modules'].includes(e.name)) return [];
    const file = path.join(dir, e.name);
    assert.equal(e.isSymbolicLink(), false);
    return e.isDirectory() ? files(file) : [file];
  });
  const candidates = files(repo).filter(file => path.basename(file) === 'SKILL.md' &&
    new RegExp(`^name: ${name}$`, 'm').test(fs.readFileSync(file, 'utf8')));
  assert.equal(candidates.length, 1);
  const selected = path.dirname(candidates[0]);
  const canonical = path.resolve('.agents/skills', name), link = path.resolve('.claude/skills', name);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const mode = process.env.INSTALL_MODE || 'symlink';
  assert.ok(['symlink', 'copy'].includes(mode));
  // Copy fallback can leave an old canonical tree for the wrapper to replace.
  for (const target of mode === 'copy' ? [link] : [canonical, link]) fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(selected, mode === 'copy' ? link : canonical, { recursive: true });
  if (mode === 'symlink') fs.symlinkSync(path.relative(path.dirname(link), canonical), link);
  const digest = createHash('sha256');
  for (const file of files(selected).map(file => path.relative(selected, file).split(path.sep).join('/')).sort((a, b) => a.localeCompare(b))) {
    digest.update(file); digest.update(fs.readFileSync(path.join(selected, file)));
  }
  const lockFile = 'skills-lock.json';
  const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : { version: 1, skills: {} };
  lock.skills[name] = { source, sourceType: remote ? 'git' : 'local', computedHash: digest.digest('hex'),
    ...(remote ? { sourceUrl: source, ref, skillPath: path.relative(repo, candidates[0]).split(path.sep).join('/') } : {}) };
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  console.log(JSON.stringify([{ name, status: 'installed', mode }]));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
