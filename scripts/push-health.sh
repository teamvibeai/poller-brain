#!/bin/bash
# Local-only push health for maintenance reports; no fetch or network calls.
# Usage: bash "$CLAUDE_CONFIG_DIR/scripts/push-health.sh" [brain_dir]
# Defaults to the brain cwd. Git failures produce nulls + error and exit 0.
node - "${1:-.}" <<'NODE'
const { execFileSync } = require('node:child_process')
const empty = {
  branch: null,
  upstream: null,
  unpushedCommits: null,
  upstreamRefMissing: null,
  lastPushOkAt: null,
  oldestUnpushedAt: null,
}
const git = (...args) => execFileSync('git', args, {
  cwd: process.argv[2], encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
}).trim()
let health
try {
  health = { ...empty, branch: git('rev-parse', '--abbrev-ref', 'HEAD'), upstreamRefMissing: false }
  // for-each-ref retains the configured upstream name even if its ref is gone.
  const ref = git('symbolic-ref', '-q', 'HEAD')
  const upstream = git('for-each-ref', '--format=%(upstream)', ref)
  health.upstream = upstream || null
  health.upstreamRefMissing = !upstream
  if (upstream) {
    // An absent ref is expected state, while other Git errors must fail open.
    const refs = git('for-each-ref', '--format=%(refname)', upstream).split('\n')
    health.upstreamRefMissing = !refs.includes(upstream)
    if (!health.upstreamRefMissing) {
      const tip = git('rev-parse', '--verify', `${upstream}^{commit}`)
      const head = git('rev-parse', '--verify', 'HEAD^{commit}')
      health.lastPushOkAt = new Date(git('show', '-s', '--format=%cI', tip)).toISOString()
      const dates = git('log', '--format=%cI', `${tip}..${head}`)
      const unpushed = dates ? dates.split('\n') : []
      health.unpushedCommits = unpushed.length
      // Minimum commit timestamp, independent of traversal order or clock skew.
      health.oldestUnpushedAt = unpushed.length
        ? new Date(unpushed.reduce((oldest, date) => Math.min(oldest, Date.parse(date)), Infinity)).toISOString() : null
    }
  }
} catch (error) {
  health = { ...empty, error: String(error.stderr || error.message).trim() }
}
console.log(`PUSH_HEALTH_JSON: ${JSON.stringify(health)}`)
NODE
