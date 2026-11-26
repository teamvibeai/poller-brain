// Slice 1: admission and conservative assessment only. Producer claims cannot verify
// success until an objective verifier is implemented; never execute receipt content.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const MAX_CONTRACT_BYTES = 64 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))
const text = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const absolute = value => text(value, 4096) && isAbsolute(value)

export function readCompletionContract(path) {
  let fd
  try {
    // Do not follow a symlink or block admission on a FIFO/device.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_CONTRACT_BYTES) throw new Error()
    const bytes = Buffer.alloc(MAX_CONTRACT_BYTES + 1)
    const length = readSync(fd, bytes, 0, bytes.length, 0)
    if (length > MAX_CONTRACT_BYTES) throw new Error()
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    if (!keys(value, ['schemaVersion', 'mode', 'scope', 'expectedOutput', 'allowedWorkArea', 'acceptance', 'producer', 'verifierPolicy', 'repository']) ||
      value.schemaVersion !== 1 || value.mode !== 'evidence-v1' ||
      !text(value.scope) || !text(value.expectedOutput) || !absolute(value.allowedWorkArea) ||
      value.verifierPolicy !== 'deferred-v1' ||
      !keys(value.producer, ['adapter', 'version']) || value.producer.adapter !== 'receipt-v1' || value.producer.version !== '1' ||
      !Array.isArray(value.acceptance) || value.acceptance.length < 1 || value.acceptance.length > 64 ||
      !value.acceptance.every(rule => keys(rule, ['id', 'required', 'rule']) &&
        typeof rule.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rule.id) &&
        typeof rule.required === 'boolean' && rule.rule === 'manual-review') ||
      new Set(value.acceptance.map(rule => rule.id)).size !== value.acceptance.length ||
      !value.acceptance.some(rule => rule.required)) throw new Error()
    if (value.repository !== undefined && (!keys(value.repository, ['path', 'baseHead']) ||
      !absolute(value.repository.path) || typeof value.repository.baseHead !== 'string' || !/^[a-f0-9]{40}$/.test(value.repository.baseHead))) throw new Error()
    // Fixed order and explicit fields keep the durable record bounded and sanitized.
    return {
      schemaVersion: 1, mode: 'evidence-v1', scope: value.scope,
      expectedOutput: value.expectedOutput, allowedWorkArea: value.allowedWorkArea,
      acceptance: value.acceptance.map(({ id, required, rule }) => ({ id, required, rule })),
      producer: { adapter: 'receipt-v1', version: '1' }, verifierPolicy: 'deferred-v1',
      ...(value.repository ? { repository: { path: value.repository.path, baseHead: value.repository.baseHead } } : {}),
    }
  } catch {
    // Never reflect untrusted contract contents or filesystem errors into diagnostics.
    throw new Error('invalid completion contract (expected bounded evidence-v1 / deferred-v1 JSON)')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function freezeCompletionContract(contract, taskId, dir) {
  const frozen = {
    ...contract, taskId, attemptNonce: randomBytes(16).toString('hex'),
    contractDigest: createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
    receiptPath: 'completion.v1.json', assessmentPath: 'assessment.v1.json',
  }
  writeFileSync(join(dir, 'contract.json'), JSON.stringify(frozen) + '\n', { mode: 0o600, flag: 'wx' })
  return frozen
}

// Process failures have precedence even if a producer claims completion. This policy
// deliberately never emits verified_success, nor reads/parses a producer receipt.
export function processFailure({ rc, timedOut, killedBy }) {
  if (timedOut) return 'process_timeout'
  if (killedBy) return 'process_signal'
  if (rc !== undefined && rc !== null && String(rc) !== '0') return 'process_exit_nonzero'
  return ''
}

export function assessCompletion(contract, dir, processFacts) {
  const failure = processFailure(processFacts)
  const assessment = {
    schemaVersion: 1, taskId: contract.taskId, attemptNonce: contract.attemptNonce,
    contractDigest: contract.contractDigest, verifierPolicy: contract.verifierPolicy,
    taskOutcome: failure ? 'failed' : 'unverified', reason: failure || 'verifier_unavailable',
  }
  if (!failure) {
    try { lstatSync(join(dir, contract.receiptPath)) }
    catch (e) { assessment.reason = e.code === 'ENOENT' ? 'receipt_missing' : 'verification_error' }
  }
  try {
    const path = join(dir, contract.assessmentPath)
    writeFileSync(`${path}.tmp`, JSON.stringify(assessment) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(`${path}.tmp`, path)
    return { ...assessment, assessmentRef: contract.assessmentPath }
  } catch {
    // Best-effort notification must still happen if persisting assessment fails.
    return { ...assessment, reason: failure || 'assessment_write_failed', assessmentRef: '-' }
  }
}

export function taskOutcomeOf(kv, state) {
  if (kv.mode !== 'evidence-v1') return { mode: 'process-only', taskOutcome: 'not verified', outcomeReason: 'not_requested', assessment: '-' }
  const failure = processFailure({ rc: kv.rc, timedOut: state === 'timed-out', killedBy: kv.killed_by })
  const terminal = state !== 'running'
  return {
    mode: 'evidence-v1',
    taskOutcome: failure ? 'failed' : terminal ? 'unverified' : 'pending',
    outcomeReason: failure || (terminal ? (kv.outcome_reason || 'runner_unavailable') : '-'),
    assessment: kv.assessment || '-',
  }
}
