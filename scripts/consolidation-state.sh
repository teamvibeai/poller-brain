#!/bin/bash
# Read-only completion check shared by Step 0 and maintenance-guard.sh.
# Exit 0 = complete/no checkpoint, 1 = resume, 2 = history unavailable.
# JSON reports are consumed by the platform: verify the pair in the final
# commit's tree, not only on disk. Never trust a report filename alone.
BRAIN_DIR="${1:-.}"
if ! git -C "$BRAIN_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "consolidation_state: unknown (git history unavailable; inspect before citing)"
  exit 2
fi
# git --grep also searches commit bodies; filter subjects before selecting.
if ! CANDIDATES=$(git -C "$BRAIN_DIR" log --format='%H %s' --extended-regexp \
  --grep='^chore: consolidate memory checkpoint \([0-9]{4}-[0-9]{2}-[0-9]{2}\)' 2>/dev/null); then
  echo "consolidation_state: unknown (cannot read checkpoint history; inspect before citing)"
  exit 2
fi
CHECKPOINT=$(printf '%s\n' "$CANDIDATES" | sed -nE '/^[0-9a-f]+ chore: consolidate memory checkpoint \([0-9]{4}-[0-9]{2}-[0-9]{2}\)/{p;q;}')
if [ -z "$CHECKPOINT" ]; then
  if [ "$(git -C "$BRAIN_DIR" rev-parse --is-shallow-repository)" = true ]; then
    echo "consolidation_state: unknown (shallow history without a visible checkpoint; inspect before citing)"
    exit 2
  fi
  echo "consolidation_state: none (no checkpoint in available history)"
  exit 0
fi
CHECKPOINT_SHA=${CHECKPOINT%% *}
CYCLE_DATE=$(printf '%s\n' "$CHECKPOINT" | sed -nE 's/.*checkpoint \(([0-9]{4}-[0-9]{2}-[0-9]{2})\).*/\1/p')
if ! FINALS=$(git -C "$BRAIN_DIR" log --format='%H %s' --extended-regexp \
  --grep="^chore: consolidate memory \($CYCLE_DATE\)$" "$CHECKPOINT_SHA..HEAD" 2>/dev/null); then
  echo "consolidation_state: unknown (cannot read final history; inspect before citing)"
  exit 2
fi
FINAL=$(printf '%s\n' "$FINALS" | awk -v subject="chore: consolidate memory ($CYCLE_DATE)" \
  'substr($0, index($0, " ") + 1) == subject { print $1; exit }')
REASON="matching final commit missing after checkpoint"
if [ -n "$FINAL" ]; then
  REASON="report pair missing from final commit or markdown missing on disk"
  if git -C "$BRAIN_DIR" cat-file -e "$FINAL:reports/$CYCLE_DATE-memory-consolidation.md" 2>/dev/null &&
     git -C "$BRAIN_DIR" cat-file -e "$FINAL:reports/$CYCLE_DATE-memory-consolidation.json" 2>/dev/null &&
     [ -f "$BRAIN_DIR/reports/$CYCLE_DATE-memory-consolidation.md" ]; then
    # A written report plus an uncommitted report edit is not finished.
    # Ignore the expected platform deletion of the consumed JSON report.
    DIRTY=$(git -C "$BRAIN_DIR" status --porcelain -- "reports/$CYCLE_DATE-memory-consolidation.md" "reports/$CYCLE_DATE-memory-consolidation.json" |
      awk -v consumed="reports/$CYCLE_DATE-memory-consolidation.json" \
        '!(substr($0, 1, 2) ~ /^ D$|^D $/ && substr($0, 4) == consumed)')
    if [ -z "$DIRTY" ]; then
      echo "consolidation_state: complete ($CYCLE_DATE; final $FINAL; report pair committed)"
      exit 0
    fi
    REASON="uncommitted report changes; inspect before starting another cycle"
  fi
fi
echo "consolidation_resume: true ($CYCLE_DATE; checkpoint $CHECKPOINT_SHA; $REASON)"
exit 1
