import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../check-previous-recommendations.sh', import.meta.url))
const heading = '## Previous Recommendations Review\n'
const firstRun = '- Not applicable: first reflection run; no prior recommendations to review.\n'
const emptyPrior = '- Not applicable: prior recommendations list is empty.\n'
const review = status => `${heading}### Prior recommendation: Split oversized memory file\n- Status: ${status}\n- Reason/evidence: See memory/semantic/project.md.\n`

function fixture(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'reflection-review-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const report = join(dir, 'current reflection.md')
  if (content !== undefined) writeFileSync(report, content)
  const check = (mode = 'required', env = {}) => spawnSync('bash', [script, report, mode], {
    encoding: 'utf8', env: { ...process.env, ...env },
  })
  return { dir, report, check }
}

function expectResult(result, passes) {
  assert.ifError(result.error)
  assert.equal(result.status, passes ? 0 : 1, result.stdout + result.stderr)
  if (passes) {
    assert.match(result.stdout, /validation passed/)
    assert.equal(result.stderr, '')
  } else {
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^\[blocked\] Previous Recommendations Review validation failed:/)
  }
}

for (const status of ['Closed', 'Moot', 'Pending', 'Pending+Deadline', 'Failure-Mode']) {
  test(`newly written report accepts applied ${status}`, t => {
    const content = `# Memory Reflection\n\n## Summary\n- Files reviewed: 2\n\n${review(status)}\n## Changes Made\n- Split the file.\n`
    expectResult(fixture(t, content).check(), true)
  })
}

const rejects = [
  ['review without status', heading + 'Reviewed all prior recommendations.\n'],
  ['lowercase legacy pending', review('pending')],
  ['legacy status summary', heading + '- Prior rec: Split the file — status: implemented.\n'],
  ['vocabulary prose', heading + 'Labels: Closed, Moot, Pending, Pending+Deadline, Failure-Mode.\n'],
  ['vocabulary in status field', review('Closed, Moot, Pending, Pending+Deadline, Failure-Mode')],
  ['label before the section', '- Status: Closed\n' + heading + 'No status here.\n'],
  ['label after the section', heading + 'No status here.\n## Changes Made\n- Status: Closed\n'],
  ['label after a level-one heading', heading + '# Appendix\n- Status: Closed\n'],
  ['label without explicit field', heading + '- Closed\n'],
  ['partial Closed token', review('ClosedLoop')],
  ['partial Pending token', review('PendingReview')],
  ['deadline suffix', review('Pending+DeadlineExtra')],
  ['deadline punctuation suffix', review('Pending+Deadline-extra')],
  ['unescaped-plus impostor', review('PendingDeadline')],
  ['repeated-plus impostor', review('PendinggDeadline')],
  ['token prefix', review('NotClosed')],
  ['quoted status field', heading + '> - Status: Closed\n'],
  ['indented code example', heading + '    - Status: Closed\n'],
  ['backtick fenced status example', heading + '```markdown\n- Status: Closed\n```\n'],
  ['tilde fenced status example', heading + '~~~markdown\n- Status: Closed\n~~~\n'],
  ['fenced section only', '```markdown\n' + review('Closed') + '```\n'],
  ['missing required section', '# Memory Reflection\n- Status: Closed\n'],
  ['wrong heading level', '### Previous Recommendations Review\n- Status: Closed\n'],
  ['duplicate section', review('Closed') + review('Pending')],
  ['first-run marker with prior recommendations', heading + firstRun],
  ['empty-prior marker with prior recommendations', heading + emptyPrior],
]
for (const [name, content] of rejects) {
  test(`rejects ${name}`, t => expectResult(fixture(t, content).check(), false))
}

test('CRLF and trailing whitespace preserve canonical fields', t => {
  expectResult(fixture(t, review('Pending+Deadline  ').replaceAll('\n', '\r\n')).check(), true)
})

test('at least one applied status suffices for this presence check', t => {
  expectResult(fixture(t, review('Closed') + '### Prior recommendation: Still needs substantive review\n').check(), true)
})

test('mixed and shorter fences cannot expose a code example as an applied status', t => {
  const content = heading + '````markdown\n~~~\n```\n- Status: Closed\n````\n'
  expectResult(fixture(t, content).check(), false)
})

for (const [mode, marker, other] of [
  ['first-run', firstRun, emptyPrior],
  ['empty-prior', emptyPrior, firstRun],
]) {
  test(`${mode} accepts explicit N/A without fabricated lifecycle status`, t => {
    expectResult(fixture(t, heading + marker).check(mode), true)
  })
  for (const [name, content] of [
    ['missing section', marker],
    ['no explanation', heading],
    ['wrong exemption', heading + other],
    ['explanation outside section', marker + heading],
    ['only a lifecycle status', review('Closed')],
    ['fenced exemption', heading + '```\n' + marker + '```\n'],
  ]) {
    test(`${mode} rejects ${name}`, t => expectResult(fixture(t, content).check(mode), false))
  }
}

for (const mode of ['required', 'first-run', 'empty-prior']) {
  test(`${mode} fails for a missing file`, t => expectResult(fixture(t).check(mode), false))
  test(`${mode} fails for a directory instead of a report`, t => {
    const f = fixture(t)
    mkdirSync(f.report)
    expectResult(f.check(mode), false)
  })
  test(`${mode} fails for an unreadable report`, t => {
    if (process.getuid?.() === 0) return t.skip('root bypasses file read permissions; read errors are tested separately')
    const f = fixture(t, review('Closed') + firstRun + emptyPrior)
    chmodSync(f.report, 0o000)
    expectResult(f.check(mode), false)
  })
  for (const command of ['awk', 'grep']) {
    test(`${mode} fails on ${command} errors even with matching partial output`, t => {
      const f = fixture(t, review('Closed') + firstRun + emptyPrior)
      const bin = join(f.dir, 'bin')
      mkdirSync(bin)
      // Simulate an I/O/command error after otherwise matching output.
      writeFileSync(join(bin, command), '#!/bin/bash\nprintf "%s\\n" "- Status: Closed" "- Not applicable: first reflection run; no prior recommendations to review." "- Not applicable: prior recommendations list is empty."\nexit 2\n', { mode: 0o755 })
      expectResult(f.check(mode, { PATH: `${bin}:${process.env.PATH}` }), false)
    })
  }
}

test('unknown mode fails rather than skipping validation', t => {
  expectResult(fixture(t, review('Closed')).check('unknown'), false)
})

test('missing arguments fail rather than skipping validation', () => {
  expectResult(spawnSync('bash', [script], { encoding: 'utf8' }), false)
})

test('a failed draft can be repaired and checked again without editing a past report', t => {
  const f = fixture(t, heading + '- Status: pending\n')
  expectResult(f.check(), false)
  writeFileSync(f.report, review('Pending+Deadline') + '- Deadline: 2026-11-30; next action: split the file.\n')
  expectResult(f.check(), true)
})
