#!/usr/bin/env npx tsx
// Intentionally uses the JavaScript subset of TypeScript: node --test can run
// an identical .mjs copy without downloading a TypeScript test runner.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const skillsDir = path.join(cwd, '.claude/skills');
const lockPath = path.join(skillsDir, 'skills.lock.yaml');
const toolLockPath = path.join(cwd, 'skills-lock.json');
const env = { ...process.env, DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', GIT_TERMINAL_PROMPT: '0' };
const defaults = ['knedlopark/shared-claude-skills', 'teamvibeai/poller-brain'];
function fail(message) { throw new Error(message); }
function run(command, args, dir = cwd, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${command} failed: ${result.error?.message || result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}
function json(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function ignoreAgents() {
  const file = path.join(cwd, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes('.agents/')) write(file, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + '.agents/\n');
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function metadata(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'computedHash').sort(([a], [b]) => a.localeCompare(b))); }
function scalar(text) {
  text = text.trim();
  if (text.startsWith('"') || text.startsWith('[') || text.startsWith('{')) {
    try { return JSON.parse(text); } catch { fail(`Invalid quoted/flow YAML value: ${text}`); }
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) fail('Invalid YAML single quoted scalar');
    return text.slice(1, -1).replace(/''/g, "'");
  }
  text = text.replace(/\s+#.*$/, '').trim();
  if (/[:]\s|^[\[\]{}&*!>|%@`]/.test(text)) fail(`Unsupported or malformed YAML scalar: ${text}`);
  if (text === 'null' || text === '~') return null;
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) return Number(text);
  return text;
}
// Deliberately bounded YAML: mappings, scalar lists, quotes, JSON flow values,
// block strings. Reject unsupported constructs instead of guessing at policy.
function yaml(text) {
  text = text.replace(/\r\n/g, '\n');
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) return JSON.parse(text);
  const lines = text.split('\n');
  let index = 0;
  function block(indent) {
    let out;
    while (index < lines.length) {
      const raw = lines[index];
      if (!raw.trim() || raw.trimStart().startsWith('#')) { index++; continue; }
      if (/^\s*\t/.test(raw)) fail('Tabs in YAML indentation');
      const spaces = raw.length - raw.trimStart().length;
      if (spaces < indent) break;
      if (spaces !== indent) fail('Invalid YAML indentation');
      const text = raw.slice(indent);
      if (text.startsWith('- ')) {
        if (out === undefined) out = [];
        if (!Array.isArray(out)) fail('Mixed YAML list and mapping');
        out.push(scalar(text.slice(2))); index++; continue;
      }
      if (out === undefined) out = Object.create(null);
      if (Array.isArray(out)) fail('Mixed YAML list and mapping');
      const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
      if (!match || Object.hasOwn(out, match[1])) fail(`Invalid or duplicate YAML key: ${text}`);
      const [, key, value] = match; index++;
      if (value && /^[|>][-+]?$/.test(value)) {
        const content = [];
        while (index < lines.length && (!lines[index].trim() || lines[index].search(/\S/) > indent)) content.push(lines[index++].trim());
        out[key] = content.join(value.startsWith('>') ? ' ' : '\n').trim();
      } else if (value !== undefined) out[key] = scalar(value);
      else {
        let next = index;
        while (next < lines.length && (!lines[next].trim() || lines[next].trimStart().startsWith('#'))) next++;
        out[key] = next < lines.length && lines[next].search(/\S/) > indent ? block(lines[next].search(/\S/)) : null;
      }
    }
    return out ?? Object.create(null);
  }
  return block(0);
}
function lock() {
  const value = fs.existsSync(lockPath) ? yaml(fs.readFileSync(lockPath, 'utf8')) : { skills: {} };
  if (!object(value) || !object(value.skills)) fail('Invalid skills.lock.yaml: expected skills mapping');
  for (const [name, entry] of Object.entries(value.skills)) {
    validName(name);
    if (!object(entry) || !['source', 'path', 'ref', 'sha', 'content_hash'].every(k => typeof entry[k] === 'string') || !/^[0-9a-f]{40}$/.test(entry.sha) || !/^[0-9a-f]{64}$/.test(entry.content_hash) || !(entry.upstream_pr === null || typeof entry.upstream_pr === 'string')) fail(`Invalid provenance entry: ${name}`);
    if (entry.path !== '.') safeRelative(entry.path);
  }
  return value;
}
function yamlScalar(value) {
  if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_./-]*$/.test(value) && !/^(?:null|true|false|yes|no|on|off)$/i.test(value)) return value;
  return JSON.stringify(value);
}
function blockYaml(value, indent = '') {
  return Object.keys(value).sort().map(key => {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) fail(`Unsupported YAML key: ${key}`);
    const item = value[key], prefix = `${indent}${key}:`;
    if (object(item) && Object.keys(item).length) return `${prefix}\n${blockYaml(item, indent + '  ')}`;
    if (Array.isArray(item) && item.length) return `${prefix}\n${item.map(v => `${indent}  - ${yamlScalar(v)}\n`).join('')}`;
    return `${prefix} ${yamlScalar(item)}\n`;
  }).join('');
}
function saveLock(value) { write(lockPath, blockYaml(value)); }
function validName(name) { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || '')) fail(`Invalid skill name: ${name}`); return name; }
function safeRelative(value) {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).some(p => p === '..' || p === '.git' || p === '') || value.includes('\\')) fail(`Unsafe skill path: ${value}`);
  return value;
}
function realInside(root, file) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative === '..') fail(`Path escapes skill: ${file}`);
}
function files(root) {
  const result = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) fail(`Symlinks are not supported: ${file}`);
      if (e.isDirectory()) walk(file);
      else if (e.isFile()) result.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  if (!fs.existsSync(root)) fail(`Missing skill directory: ${root}`);
  if (fs.lstatSync(root).isSymbolicLink()) fail(`Skill must be a copy: ${root}`);
  walk(root);
  return result.sort((a, b) => a.localeCompare(b));
}
function hash(root) {
  const digest = createHash('sha256');
  for (const file of files(root)) { digest.update(file); digest.update(fs.readFileSync(path.join(root, file))); }
  return digest.digest('hex');
}
function frontmatter(file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(fs.readFileSync(file, 'utf8'));
  if (!match) fail(`Missing or unclosed frontmatter: ${file}`);
  const data = yaml(match[1]);
  if (!object(data)) fail(`Frontmatter must be a mapping: ${file}`);
  if (typeof data.name !== 'string' || !data.name.trim()) fail(`Missing name: ${file}`);
  if (typeof data.description !== 'string' || !data.description.trim()) fail(`Missing description: ${file}`);
  return data;
}
function sourceInfo(source) {
  if (!source || source.startsWith('-') || source.includes('#') || /[\n\r\0]/.test(source)) fail('Invalid source');
  if (/^(\/|\.\.?\/|file:\/\/)/.test(source)) {
    const local = fs.realpathSync(source.startsWith('file://') ? new URL(source) : path.resolve(cwd, source));
    return { identity: local, url: local, local: true };
  }
  let value = source.replace(/^github\.com\//, '').replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return { identity: `github.com/${value.toLowerCase()}`, url: `https://github.com/${value}.git`, local: false };
  if (!/^(https:\/\/[^\s?#]+\.git|ssh:\/\/[^\s?#]+\.git|git@[^\s:]+:[^\s?#]+\.git)$/.test(source)) fail('Use owner/repo, a git URL ending .git, or a local git path');
  return { identity: source.replace(/\/$/, ''), url: source, local: false };
}
function allowed(source) {
  const info = sourceInfo(source), file = path.join(skillsDir, 'allowlist.yaml');
  let list = defaults;
  if (fs.existsSync(file)) {
    const value = yaml(fs.readFileSync(file, 'utf8'));
    list = Array.isArray(value) ? value : value?.sources ?? value?.allowlist;
    if (!Array.isArray(list) || !list.every(v => typeof v === 'string')) fail('allowlist.yaml must be a scalar list or sources: list');
  }
  if (!list.some(item => sourceInfo(item).identity === info.identity)) fail(`Source ${source} is outside the workspace allowlist; ask the brain owner to review a PR`);
  return info;
}
function remoteSha(info, ref) {
  if (!ref || ref.startsWith('-') || /[\s~^:?*\[\\]/.test(ref) || ref.includes('..')) fail(`Invalid ref: ${ref}`);
  const lines = run('git', ['ls-remote', '--', info.url, ref, `${ref}^{}`, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]).split('\n').filter(Boolean).map(l => l.split(/\s+/));
  const branch = lines.find(l => l[1] === `refs/heads/${ref}` || (ref.startsWith('refs/heads/') && l[1] === ref));
  const peeled = lines.find(l => l[1] === `refs/tags/${ref}^{}` || l[1] === `${ref}^{}`);
  const direct = lines.find(l => l[1] === ref) || lines.find(l => l[1] === `refs/tags/${ref}`);
  const sha = branch?.[0] || peeled?.[0] || direct?.[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) fail(`Ref not advertised by upstream: ${ref}`);
  return sha;
}
function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(cwd, '.brain-skills-'));
  try { return callback(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function checkout(info, sha, dir) {
  run('git', ['clone', '--no-checkout', '--', info.url, dir]);
  run('git', ['checkout', '--detach', sha], dir);
}
function inventory() {
  if (!fs.existsSync(skillsDir)) return [];
  return files(skillsDir).filter(f => f.endsWith('/SKILL.md')).map(file => ({ file, name: file.split('/')[0], flat: file.split('/').length === 2 }));
}
function status() {
  const entries = [];
  const provenance = lock().skills;
  for (const [name, entry] of Object.entries(provenance)) {
    const dir = path.join(skillsDir, name);
    const modified = !fs.existsSync(path.join(dir, 'SKILL.md')) || hash(dir) !== entry.content_hash;
    const upstream_sha = remoteSha(sourceInfo(entry.source), entry.ref);
    const state = entry.upstream_pr ? 'waiting-upstream' : modified ? 'modified' : upstream_sha !== entry.sha ? 'outdated' : 'current';
    entries.push({ name, ...entry, state, upstream_sha, modified });
  }
  for (const item of inventory()) {
    if (!item.flat) entries.push({ name: item.file.slice(0, -9), path: item.file, state: 'not-discovered' });
    else if (!Object.hasOwn(provenance, item.name)) entries.push({ name: item.name, state: 'own' });
  }
  return entries;
}
function transaction(name, callback) {
  return temporary(dir => {
    const committedTargets = [path.join(skillsDir, name), toolLockPath, lockPath, path.join(cwd, '.gitignore')];
    // The CLI cache is never committed, but must also be restored on failure.
    const targets = [...committedTargets, path.join(cwd, '.agents/skills', name)];
    const existed = targets.map((target, i) => {
      if (!fs.existsSync(target)) return false;
      if (fs.lstatSync(target).isSymbolicLink()) fail(`Refusing symlink target: ${target}`);
      fs.cpSync(target, path.join(dir, String(i)), { recursive: true }); return true;
    });
    try { return callback(); }
    catch (error) {
      targets.forEach((target, i) => { fs.rmSync(target, { recursive: true, force: true }); if (existed[i]) fs.cpSync(path.join(dir, String(i)), target, { recursive: true }); });
      throw error;
    }
  });
}
function install(source, subpath, ref, requestedName, replacing = false) {
  const info = allowed(source), sha = remoteSha(info, ref);
  return temporary(temp => {
    const repo = path.join(temp, 'upstream'); checkout(info, sha, repo);
    let candidates;
    if (subpath) {
      safeRelative(subpath);
      const dir = path.join(repo, subpath); realInside(repo, dir);
      candidates = [{ dir, name: frontmatter(path.join(dir, 'SKILL.md')).name }];
    } else {
      candidates = files(repo).filter(f => f === 'SKILL.md' || f.endsWith('/SKILL.md')).map(f => ({ dir: path.dirname(path.join(repo, f)), name: frontmatter(path.join(repo, f)).name }));
    }
    if (requestedName) candidates = candidates.filter(c => c.name === requestedName);
    if (candidates.length !== 1) fail('Select exactly one skill with #path or --name');
    const selected = candidates[0], name = validName(selected.name);
    const selectedPath = path.relative(repo, selected.dir).split(path.sep).join('/') || '.';
    if (!replacing && (fs.existsSync(path.join(skillsDir, name)) || Object.hasOwn(lock().skills, name))) fail(`Skill ${name} already exists; use sync`);
    // Remote sources use the CLI's native #SHA support. For local sources the
    // CLI has no ref syntax; use a clean checkout at that SHA as its input.
    let input = `${info.url}#${sha}`;
    if (info.local) {
      const cleanHead = run('git', ['rev-parse', 'HEAD'], info.url) === sha && !run('git', ['status', '--porcelain', '--untracked-files=all'], info.url);
      input = cleanHead ? (selectedPath === '.' ? info.url : path.join(info.url, selectedPath)) : selected.dir;
    }
    return transaction(name, () => {
      const output = run('npx', ['-y', 'skills@1.7.2', 'add', input, '--skill', name, '--full-depth', '--copy', '-y', '--json', '--agent', 'claude-code']);
      const result = JSON.parse(output);
      if (!Array.isArray(result) || result.length !== 1 || result[0].status !== 'installed' || result[0].name !== name || result[0].mode !== 'copy') fail('Unexpected npx skills add result');
      const content_hash = hash(path.join(skillsDir, name));
      if (content_hash !== hash(selected.dir)) fail('Installed content differs from the resolved upstream SHA');
      const tool = json(toolLockPath, null)?.skills?.[name];
      if (!tool || tool.computedHash !== content_hash) fail('npx skills did not write the expected content lock');
      const value = lock();
      value.skills[name] = { source: info.identity, path: selectedPath, ref, sha, upstream_pr: null, content_hash,
        installer: metadata(tool) };
      saveLock(value);
      ignoreAgents();
      return { name, ...value.skills[name] };
    });
  });
}
function parseSourceArg(value) {
  if (!value) fail('Missing source');
  const [source, subpath, extra] = value.split('#');
  if (extra !== undefined || subpath === '') fail('Use source#path and --ref ref');
  return { source, subpath };
}
function sync(name, force) {
  const value = lock(), names = name ? [validName(name)] : Object.keys(value.skills);
  // Preflight all targets before overwriting any of them.
  for (const item of names) {
    const entry = value.skills[item]; if (!entry) fail(`No vendored skill: ${item}`);
    allowed(entry.source);
    const dir = path.join(skillsDir, item);
    if ((!fs.existsSync(dir) || hash(dir) !== entry.content_hash) && !entry.upstream_pr && !force) fail(`${item} is locally modified; push it upstream or use --force`);
  }
  return names.map(item => { const entry = value.skills[item]; return install(entry.source, entry.path === '.' ? undefined : entry.path, entry.ref, item, true); });
}
function lint() {
  const errors = [], seen = new Set(), value = lock(), toolLock = json(toolLockPath, { version: 1, skills: {} });
  if (run('git', ['ls-files', '--', '.agents'])) errors.push('.agents/ is tracked by git; add .agents/ to the brain .gitignore and untrack it with git rm --cached -r .agents');
  if (toolLock.version !== 1 || !object(toolLock.skills)) fail('Invalid skills-lock.json');
  if (fs.existsSync(skillsDir)) for (const item of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (item.isDirectory() && !fs.existsSync(path.join(skillsDir, item.name, 'SKILL.md'))) errors.push(`Skill directory has no SKILL.md: ${item.name}`);
  }
  for (const item of inventory()) {
    try {
      if (!item.flat) fail(`Nested skill is not-discovered: ${item.file}`);
      const file = path.join(skillsDir, item.file), data = frontmatter(file);
      validName(data.name);
      if (seen.has(data.name)) errors.push(`Duplicate skill name: ${data.name}`);
      seen.add(data.name);
      if (data.name !== item.name) errors.push(`Directory/name mismatch: ${item.name} / ${data.name}`);
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:\$CLAUDE_CONFIG_DIR\/skills\/[a-z0-9-]+\/)?scripts\/([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)/g)) {
        const referenced = path.join(skillsDir, item.name, 'scripts', match[1]);
        if (!fs.existsSync(referenced)) errors.push(`Missing referenced script: ${item.name}/scripts/${match[1]}`);
        else realInside(path.join(skillsDir, item.name), referenced);
      }
    } catch (error) { errors.push(error.message); }
  }
  for (const [name, entry] of Object.entries(value.skills)) {
    try {
      const actual = hash(path.join(skillsDir, name)), tool = toolLock.skills[name];
      if (!fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))) errors.push(`Missing SKILL.md: ${name}`);
      if (actual !== entry.content_hash && !entry.upstream_pr) errors.push(`Content hash drift: ${name}`);
      if (!tool || tool.computedHash !== entry.content_hash) errors.push(`Two-lock hash drift: ${name}`);
      if (tool && entry.installer && JSON.stringify(metadata(tool)) !== JSON.stringify(metadata(entry.installer))) errors.push(`Two-lock source/ref/path drift: ${name}`);
      const source = sourceInfo(entry.source);
      if (tool && !source.local) {
        const toolSource = sourceInfo(tool.sourceUrl || tool.source);
        const toolPath = tool.skillPath ? path.posix.dirname(tool.skillPath) : null;
        if (toolSource.identity !== source.identity || tool.ref !== entry.sha || toolPath !== entry.path) errors.push(`Two-lock provenance drift: ${name}`);
      }
    } catch (error) { errors.push(error.message); }
  }
  for (const name of Object.keys(toolLock.skills)) if (!Object.hasOwn(value.skills, name)) errors.push(`Tool lock has no provenance: ${name}`);
  if (errors.length) fail(errors.join('\n'));
  return { errors: [], count: seen.size };
}
function push(name) {
  validName(name); const value = lock(), entry = value.skills[name];
  if (!entry) fail(`No vendored skill: ${name}`);
  if (entry.upstream_pr) return { name, upstream_pr: entry.upstream_pr, changed: false };
  const info = allowed(entry.source), vendored = path.join(skillsDir, name);
  function identity(key, fallback) {
    const result = spawnSync('git', ['config', key], { cwd, env, encoding: 'utf8' });
    if (result.error || (result.status !== 0 && result.status !== 1)) fail(`git config ${key} failed: ${result.error?.message || result.stderr.trim()}`);
    return result.stdout.trim() || fallback;
  }
  const authorName = identity('user.name', 'JARVIS (Codex)'), authorEmail = identity('user.email', 'jarvis@knedlopark.cz');
  const author = `${authorName} <${authorEmail}>`;
  return temporary(temp => {
    const repo = path.join(temp, 'upstream'); checkout(info, entry.sha, repo);
    const target = entry.path === '.' ? repo : path.join(repo, entry.path); realInside(repo, target);
    // Overlay the exact vendored copy, including deletions; preserve repo .git.
    files(vendored);
    for (const item of fs.readdirSync(target)) if (item !== '.git') fs.rmSync(path.join(target, item), { recursive: true, force: true });
    for (const item of fs.readdirSync(vendored)) fs.cpSync(path.join(vendored, item), path.join(target, item), { recursive: true });
    run('git', ['add', '--all', '--', entry.path], repo);
    if (!run('git', ['diff', '--cached', '--stat'], repo)) fail(`${name} has no vendored changes to push`);
    const branch = `skill-maintenance/${name}-${randomUUID().slice(0, 8)}`;
    run('git', ['checkout', '-b', branch], repo);
    run('git', ['commit', '-m', `fix(${name}): apply brain skill improvements`], repo, {
      GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail,
    });
    run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], repo);
    const body = path.join(temp, 'pr-body.txt');
    write(body, `Apply the vendored ${name} changes from the brain, based on ${entry.sha}.\n\nBrain owner review required.\n`);
    const url = run('gh', ['pr', 'create', '--base', entry.ref, '--head', branch, '--title', `fix(${name}): apply brain skill improvements`, '--body-file', body], repo);
    if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(url)) fail('gh pr create did not return a PR URL');
    entry.upstream_pr = url; saveLock(value);
    return { name, upstream_pr: url, branch, author, changed: true };
  });
}
function main(args) {
  const root = run('git', ['rev-parse', '--show-toplevel']);
  if (fs.realpathSync(root) !== fs.realpathSync(cwd)) fail('Run brain-skills from the brain repository root');
  for (const relative of ['.claude', '.claude/skills', '.agents', '.agents/skills', 'skills-lock.json', '.gitignore']) {
    const target = path.join(cwd, relative);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fail(`Refusing symlink target: ${relative}`);
  }
  const command = args.shift(), options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--ref', '--name', '--new'].includes(arg)) { if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`Missing value for ${arg}`); options[arg] = args[++i]; }
    else if (['--force', '--json'].includes(arg)) options[arg] = true;
    else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const allowedOptions = { add: ['--ref', '--name', '--new'], ensure: ['--ref'], status: ['--json'], sync: ['--force'], push: [], lint: [], report: [] };
  if (!allowedOptions[command]) fail('Commands: add, ensure, status, sync, push, lint, report');
  for (const key of Object.keys(options)) if (!allowedOptions[command].includes(key)) fail(`Option ${key} is not valid for ${command}`);
  const max = command === 'ensure' ? 2 : ['add', 'sync', 'push'].includes(command) ? 1 : 0;
  if (positional.length > max) fail(`Too many arguments for ${command}`);
  if (command === 'add' && options['--new']) {
    if (positional.length || options['--ref'] || options['--name']) fail('--new cannot be combined with source options');
    const name = validName(options['--new']), dir = path.join(skillsDir, name);
    if (fs.existsSync(dir) || Object.hasOwn(lock().skills, name)) fail(`Skill ${name} already exists`);
    write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Describe when to use ${name} and the result it produces.\n---\n\n# ${name}\n\nDescribe the workflow.\n`);
    ignoreAgents();
    return { name, state: 'own', path: path.relative(cwd, dir) };
  }
  if (command === 'add' || command === 'ensure') {
    const name = command === 'ensure' ? validName(positional[0]) : options['--name'];
    const parsed = parseSourceArg(positional[command === 'ensure' ? 1 : 0]);
    allowed(parsed.source);
    if (command === 'ensure' && lock().skills[name] && fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))) { ignoreAgents(); return { name, changed: false }; }
    const replacing = command === 'ensure' && Boolean(lock().skills[name]);
    return { ...install(parsed.source, parsed.subpath, options['--ref'] || 'main', name, replacing), changed: true };
  }
  if (command === 'sync') { const entries = sync(positional[0], options['--force']); ignoreAgents(); return { entries }; }
  if (command === 'push') return push(positional[0]);
  if (command === 'lint') return lint();
  const entries = status();
  if (command === 'status') return { entries };
  const counts = Object.fromEntries(['current', 'outdated', 'modified', 'waiting-upstream', 'own', 'not-discovered'].map(state => [state, entries.filter(e => e.state === state).length]));
  return { counts, entries };
}
try { console.log(JSON.stringify({ ok: true, data: main(process.argv.slice(2)), error: null })); }
catch (error) { console.log(JSON.stringify({ ok: false, data: null, error: error.message })); process.exitCode = 1; }
