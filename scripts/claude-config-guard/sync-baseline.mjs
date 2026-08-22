#!/usr/bin/env node
// PostToolUse hook (matcher: "Edit|Write") -- one half of the pb#299 tamper-guard pair.
//
// After every Edit/Write call that touches an in-scope .claude/** path, refresh the
// trusted baseline so check-bash-diff.mjs (the other half, matcher: "Bash") doesn't flag
// legitimate, tool-mediated changes on the next Bash call.
//
// Caveat, flagged by DevGuru in the pb#299 review thread (2026-08-10): this treats EVERY
// Edit/Write write as trusted, including one made by a compromised/prompt-injected agent
// using Edit/Write itself. That is a different threat this pair does not defend against --
// it only distinguishes "went through the Edit/Write tool" (attributable in the session
// transcript) from "did not" (e.g. `cp`, `sed -i`, `python -c` from Bash), not "was
// reviewed by a human". See pb#299 for the fuller threat-model discussion.
//
// Fails open: any error here (bad/missing stdin JSON, unreadable file) exits 0 rather than
// blocking the tool call that already completed -- PostToolUse hooks report on a call that
// already happened, so there is nothing left to "block".
import { relative, resolve } from 'node:path'
import { isInScope, readHookPayload, snapshot, writeBaseline } from './lib.mjs'

const payload = readHookPayload()
if (!payload) process.exit(0)

const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const filePath = payload.tool_input?.file_path
if (!filePath) process.exit(0)

let rel
try {
  rel = relative(projectDir, resolve(projectDir, filePath))
} catch {
  process.exit(0)
}

if (!isInScope(rel)) process.exit(0)

try {
  writeBaseline(projectDir, snapshot(projectDir))
} catch {
  // Best-effort. A failed baseline refresh just means the next Bash-side check may
  // false-positive on this legitimate change -- annoying, not unsafe (alert-only default).
}
process.exit(0)
