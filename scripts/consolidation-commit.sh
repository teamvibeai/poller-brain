#!/bin/bash
# Commit only consolidation work, preserving unrelated index/worktree changes.
# Usage: bash consolidation-commit.sh BRAIN_DIR YYYY-MM-DD BOUNDARY [EXACT_PATH...]
# BOUNDARY is a checkpoint label (e.g. "step 0") or "final". Extra paths must
# be individually reviewed skill outputs (e.g. HEARTBEAT.md), never directories.
# Strict mode: --memory-only BRAIN_DIR YYYY-MM-DD BOUNDARY EXACT_MEMORY_PATH...
# Requires a valid cycle marker and clean target index; never sweeps memory/.
set -euo pipefail
if [ "${1:-}" = --memory-only ]; then
  shift
  exec node "$(dirname "${BASH_SOURCE[0]}")/consolidation-transaction.mjs" commit "$@"
fi
BRAIN_DIR=${1:?brain directory required}
CYCLE_DATE=${2:?cycle date required}
BOUNDARY=${3:?checkpoint boundary or final required}
shift 3
[[ "$CYCLE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo 'invalid cycle date' >&2; exit 2; }
cd "$BRAIN_DIR"
JSON="reports/$CYCLE_DATE-memory-consolidation.json"
ALLOWLIST=(memory/ "reports/$CYCLE_DATE-memory-consolidation.md" "$JSON")
for path in "$@"; do
  case "$path" in
    HEARTBEAT.md|CLAUDE.md|skills/*/SKILL.md|scripts/*) ;;
    *) echo "not a consolidation output: $path" >&2; exit 2 ;;
  esac
  # Reject traversal, pathspec magic/globs and directories, including absent ones.
  case "$path" in
    */|*..*|*\**|*\?*|*\[*|*:*) echo "not an exact output path: $path" >&2; exit 2 ;;
  esac
  [ ! -d "$path" ] || { echo "not an output file: $path" >&2; exit 2; }
  ALLOWLIST+=("$path")
done
MANIFEST=$(mktemp)
trap 'rm -f "$MANIFEST"' EXIT
# Include staged deletions and untracked outputs as well as working-tree edits.
# --no-renames keeps both sides of moves explicit and scoped to the allowlist.
git diff HEAD --name-only --no-renames -z -- "${ALLOWLIST[@]}" > "$MANIFEST"
git ls-files --others --exclude-standard -z -- "${ALLOWLIST[@]}" >> "$MANIFEST"
PATHS=()
while IFS= read -r -d '' path; do
  # Consumption is platform work, never part of a consolidation commit. This
  # also leaves a pre-staged JSON deletion staged without committing it.
  if [ "$path" = "$JSON" ] && { [ "$BOUNDARY" = final ] || [ ! -e "$path" ]; }; then continue; fi
  PATHS+=("$path")
done < "$MANIFEST"
if [ "$BOUNDARY" = final ]; then
  SUBJECT="chore: consolidate memory ($CYCLE_DATE)"
else
  SUBJECT="chore: consolidate memory checkpoint ($CYCLE_DATE) — $BOUNDARY"
fi
if [ "${#PATHS[@]}" -eq 0 ]; then
  if [ "$BOUNDARY" = final ]; then
    git commit --only --allow-empty -m "$SUBJECT"
  fi
  exit 0
fi
# Register new outputs and stage changes only for these exact paths. An already
# staged deletion needs no further add (git add rejects an absent index entry).
for path in "${PATHS[@]}"; do
  if [ -e "$path" ] || git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    git add -- "$path"
  fi
done
# --only commits these working-tree paths and leaves every other staged entry
# intact, including partially staged user files and consumed JSON deletions.
git commit --only -m "$SUBJECT" -- "${PATHS[@]}"
