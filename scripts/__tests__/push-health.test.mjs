// Run: node --test scripts/__tests__/push-health.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../push-health.sh', import.meta.url))
const baseDate = '2026-01-01T12:00:00.000Z'
function brain(t) {
  const dir = mkdtempSync(join(tmpdir(), 'push-health-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: baseDate, GIT_COMMITTER_DATE: baseDate },
  }).trim()
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  return { dir, git }
}
function report(dir) {
  const result = spawnSync('bash', [script], { cwd: dir, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^PUSH_HEALTH_JSON: [^\n]+\n$/)
  return JSON.parse(result.stdout.slice('PUSH_HEALTH_JSON: '.length))
}
function upstream(git) {
  git('remote', 'add', 'origin', 'https://invalid.example/never-contact')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('config', 'branch.main.remote', 'origin')
  git('config', 'branch.main.merge', 'refs/heads/main')
}
test('no upstream', t => {
  const { dir } = brain(t)
  assert.deepEqual(report(dir), { branch: 'main', upstream: null, unpushedCommits: null,
    upstreamRefMissing: true, lastPushOkAt: null, oldestUnpushedAt: null })
})
test('clean upstream', t => {
  const { dir, git } = brain(t)
  upstream(git)
  assert.deepEqual(report(dir), { branch: 'main', upstream: 'refs/remotes/origin/main',
    unpushedCommits: 0, upstreamRefMissing: false, lastPushOkAt: baseDate, oldestUnpushedAt: null })
})
test('N commits ahead', t => {
  const { dir, git } = brain(t)
  upstream(git)
  for (let i = 0; i < 3; i++) git('commit', '-q', '--allow-empty', '-m', `ahead ${i}`)
  assert.deepEqual(report(dir), { branch: 'main', upstream: 'refs/remotes/origin/main',
    unpushedCommits: 3, upstreamRefMissing: false, lastPushOkAt: baseDate, oldestUnpushedAt: baseDate })
})
test('configured upstream ref missing', t => {
  const { dir, git } = brain(t)
  upstream(git)
  git('update-ref', '-d', 'refs/remotes/origin/main')
  assert.deepEqual(report(dir), { branch: 'main', upstream: 'refs/remotes/origin/main',
    unpushedCommits: null, upstreamRefMissing: true, lastPushOkAt: null, oldestUnpushedAt: null })
})
test('git error fails open with nulls and error', t => {
  const { dir } = brain(t)
  rmSync(join(dir, '.git'), { recursive: true })
  const { error, ...health } = report(dir)
  assert.match(error, /not a git repository/)
  assert.deepEqual(health, { branch: null, upstream: null, unpushedCommits: null,
    upstreamRefMissing: null, lastPushOkAt: null, oldestUnpushedAt: null })
})
