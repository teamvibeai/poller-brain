#!/bin/bash
# Read-only completion check shared by Step 0 and maintenance-guard.sh.
# The durable start marker precedes checkpoints, reports and cadence.
# Exit 0 = complete/no unfinished evidence, 1 = resume, 2 = inspect unknown history.
# JSON is consumed by the platform. Evidence may live in Step 12a's checkpoint
# even when the final marker's tree no longer contains the JSON.
BRAIN_DIR="${1:-.}"
export GIT_OPTIONAL_LOCKS=0  # detection must not refresh or rewrite the index
unknown() {
  echo "consolidation_state: unknown ($1; inspect before citing)"
  exit 2
}
resume() {
  echo "consolidation_resume: true ($1; $2; inspect existing work and resume)"
  exit 1
}
pair_in_commit() {
  git -C "$BRAIN_DIR" cat-file -e "$1:reports/$2-memory-consolidation.md" 2>/dev/null &&
    git -C "$BRAIN_DIR" cat-file -e "$1:reports/$2-memory-consolidation.json" 2>/dev/null
}
final_for_date() {
  local candidates
  candidates=$(git -C "$BRAIN_DIR" log --format='%H %s' --extended-regexp \
    --grep="^chore: consolidate memory \($1\)$" "${2:-HEAD}" 2>/dev/null) || return 2
  printf '%s\n' "$candidates" | awk -v subject="chore: consolidate memory ($1)" \
    'substr($0, index($0, " ") + 1) == subject { print $1; exit }'
}
if ! git -C "$BRAIN_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
  unknown "git history unavailable"
fi
MARKER_OUTPUT=$(bash "$(dirname "${BASH_SOURCE[0]}")/consolidation-marker.sh" inspect "$BRAIN_DIR")
MARKER_STATUS=$?
HISTORY_RANGE=HEAD
if [ "$MARKER_STATUS" -eq 1 ]; then
  read -r _ MARKER_DATE START_HEAD _ <<< "$MARKER_OUTPUT"
  if ! git -C "$BRAIN_DIR" cat-file -e "$START_HEAD^{commit}" 2>/dev/null ||
     ! git -C "$BRAIN_DIR" merge-base --is-ancestor "$START_HEAD" HEAD 2>/dev/null; then
    unknown "start marker HEAD unavailable or outside current history; do not start a fresh cycle"
  fi
  HISTORY_RANGE="$START_HEAD..HEAD"
elif [ "$MARKER_STATUS" -ne 0 ]; then
  unknown "$MARKER_OUTPUT; do not start a fresh cycle"
fi
# git --grep also searches commit bodies; filter subjects before selecting.
if ! CANDIDATES=$(git -C "$BRAIN_DIR" log --format='%H %s' --extended-regexp \
  --grep='^chore: consolidate memory checkpoint \([0-9]{4}-[0-9]{2}-[0-9]{2}\)' "$HISTORY_RANGE" 2>/dev/null); then
  unknown "cannot read checkpoint history"
fi
CHECKPOINT=$(printf '%s\n' "$CANDIDATES" | sed -nE '/^[0-9a-f]+ chore: consolidate memory checkpoint \([0-9]{4}-[0-9]{2}-[0-9]{2}\)/{p;q;}') || unknown "cannot parse checkpoint history"
if [ -z "$CHECKPOINT" ] && [ "$MARKER_STATUS" -eq 0 ]; then
  SHALLOW=$(git -C "$BRAIN_DIR" rev-parse --is-shallow-repository 2>/dev/null) || unknown "cannot determine history depth"
  if [ "$SHALLOW" = true ]; then
    unknown "shallow history without a visible checkpoint"
  fi
  [ "$SHALLOW" = false ] || unknown "cannot determine history depth"
fi

# Uncommitted report drafts precede cadence even without a checkpoint. Ignore
# only the expected deletion of consumed JSON, never markdown or JSON edits.
REPORT_STATUS=$(git -C "$BRAIN_DIR" status --porcelain --untracked-files=all -- reports/ 2>/dev/null) || unknown "cannot inspect report changes"
DIRTY=""
if [ -n "$REPORT_STATUS" ]; then
  DIRTY=$(printf '%s\n' "$REPORT_STATUS" | awk '
  substr($0, 4) ~ /^reports\/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-memory-consolidation\.(md|json)$/ &&
  !(substr($0, 1, 2) ~ /^ D$|^D $/ && $0 ~ /\.json$/) { print }
') || unknown "cannot parse report changes"
fi
if [ -n "$DIRTY" ]; then
  resume "in progress" "uncommitted report changes; inspect and reconcile report drafts"
fi

CHECKPOINT_SHA=${CHECKPOINT%% *}
if [ "$MARKER_STATUS" -eq 1 ] && [ -n "$CHECKPOINT_SHA" ]; then
  git -C "$BRAIN_DIR" merge-base --is-ancestor "$START_HEAD" "$CHECKPOINT_SHA" 2>/dev/null ||
    unknown "checkpoint is outside the start marker's cycle history; do not start a fresh cycle"
fi
CYCLE_DATE=$(printf '%s\n' "$CHECKPOINT" | sed -nE 's/.*checkpoint \(([0-9]{4}-[0-9]{2}-[0-9]{2})\).*/\1/p') || unknown "cannot parse checkpoint date"
if [ "$MARKER_STATUS" -eq 1 ]; then
  if [ -n "$CYCLE_DATE" ] && [ "$CYCLE_DATE" != "$MARKER_DATE" ]; then
    unknown "checkpoint date conflicts with start marker; inspect existing work; do not start a fresh cycle"
  fi
  CYCLE_DATE=$MARKER_DATE
fi
TODAY=$(date -u +%F) || unknown "cannot determine report date"
# Support committed legacy completions without checkpoints, but a checkpoint-free
# report draft (even committed under another subject) is not completion evidence.
if [ "$CYCLE_DATE" != "$TODAY" ] && [ -f "$BRAIN_DIR/reports/$TODAY-memory-consolidation.md" ]; then
  TODAY_FINAL=$(final_for_date "$TODAY") || unknown "cannot read today's final history"
  if [ -z "$TODAY_FINAL" ] || ! pair_in_commit "$TODAY_FINAL" "$TODAY"; then
    resume "$TODAY; in progress" "report without committed completion evidence; inspect and reconcile"
  fi
fi
if [ -z "$CHECKPOINT" ] && [ "$MARKER_STATUS" -eq 0 ]; then
  echo "consolidation_state: none (no checkpoint in available history; no unfinished report evidence)"
  exit 0
fi
FINAL=$(final_for_date "$CYCLE_DATE" "${CHECKPOINT_SHA:-$START_HEAD}..HEAD") || unknown "cannot read final history"
REASON="matching final commit missing after cycle start/checkpoint"
if [ -n "$FINAL" ]; then
  if [ "$MARKER_STATUS" -eq 1 ]; then
    git -C "$BRAIN_DIR" merge-base --is-ancestor "$START_HEAD" "$FINAL" 2>/dev/null ||
      unknown "final commit is outside the start marker's cycle history; do not start a fresh cycle"
    git -C "$BRAIN_DIR" merge-base --is-ancestor "${CHECKPOINT_SHA:-$START_HEAD}" "$FINAL" 2>/dev/null ||
      unknown "final commit is outside the start marker's cycle history; do not start a fresh cycle"
  fi
  REASON="report pair missing from final/Step 12a checkpoint history or markdown missing on disk"
  EVIDENCE=""
  if pair_in_commit "$FINAL" "$CYCLE_DATE"; then
    EVIDENCE=$FINAL
  elif [ "${CHECKPOINT#* }" = "chore: consolidate memory checkpoint ($CYCLE_DATE) — steps 10-12" ] &&
       git -C "$BRAIN_DIR" merge-base --is-ancestor "$CHECKPOINT_SHA" "$FINAL" 2>/dev/null &&
       pair_in_commit "$CHECKPOINT_SHA" "$CYCLE_DATE"; then
    EVIDENCE=$CHECKPOINT_SHA
  fi
  if [ -n "$EVIDENCE" ] && [ -f "$BRAIN_DIR/reports/$CYCLE_DATE-memory-consolidation.md" ]; then
    echo "consolidation_state: complete ($CYCLE_DATE; final $FINAL; report pair committed at $EVIDENCE)"
    exit 0
  fi
fi
if [ "$MARKER_STATUS" -eq 1 ]; then
  resume "$CYCLE_DATE; start marker at $START_HEAD" "$REASON; do not repeat archive/reset blindly"
fi
resume "$CYCLE_DATE; checkpoint $CHECKPOINT_SHA" "$REASON"
