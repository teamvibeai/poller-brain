#!/bin/bash
# Smoke tests for skills/memory/scripts/{mem-write,log-write}.ts
# Single-entry runner, no test-framework dependency (tsx + node:assert only).
# Exit 0 = all pass, non-zero = a case failed. Mirrors scripts/maintenance-guard.sh style.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec npx tsx "$DIR/smoke.test.ts"
