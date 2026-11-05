# Bash command telemetry

The Bash PostToolUse hook attempts one `bash.command` event per call. It fails
open silently and returns without waiting for HTTP. A shared tokenizer decodes
shell words before redacting credential headers, secret assignments (including
append and simple indexed forms), flags, token signatures, and the configured
poller token. Unsupported syntax is represented by a redaction marker. Whole
`$VAR` and `${VAR}` references contain names and can be retained.

At most four delivery workers run concurrently per OS user and temporary
directory. Atomic directory claims in `teamvibe-bash-telemetry-<uid>` under the
system temporary directory bound admission across hook processes. Saturated
calls drop their event immediately. Dead worker slots are reclaimed by later
calls; abandoned parent reservations wait at least ten seconds before cleanup
to cover an orphan worker. A live PID is never evicted, even if old (PID reuse
can conservatively reduce capacity). Each worker has a 2.5-second hard lifetime,
including its 2-second HTTP timeout. No retries or command data in worker argv.

The receiver persists only `command`, `cwd`, `exitCode`, and `invokedAt`.
`exitCode: -1` means unknown. A valid input `invokedAt` is retained; otherwise
`invokedAt` is **approximate**, using the parent's receipt time before stdin is
read. Because PostToolUse runs after execution, this fallback does not measure
the invocation start and must not be used to compute command duration. The
current sanitizer discards additional fields, so no approximation flag can be
persisted without a receiver contract change.

Run the CI-selected checks with Node 22:

```sh
node hooks/__tests__/bash-telemetry.test.mjs
node hooks/__tests__/bash-telemetry-redact.test.mjs
node hooks/__tests__/bash-telemetry-regressions.test.mjs
```
