#!/bin/bash
# Validate only the current episodic report's Previous Recommendations Review.
# Usage: bash check-previous-recommendations.sh REPORT required|first-run|empty-prior
# The caller determines mode from the prior report before drafting this one.
# Exit 0 = valid applied label or explicit N/A; exit 1 = failed check/error.
set -u
set -o pipefail
export LC_ALL=C

fail() {
  printf '[blocked] Previous Recommendations Review validation failed: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  fail 'expected REPORT and required|first-run|empty-prior'
fi
report=$1
mode=$2
case "$mode" in
  required|first-run|empty-prior) ;;
  *) fail 'unknown review mode' ;;
esac

[ -f "$report" ] && [ -r "$report" ] || fail 'report is missing or unreadable'

# Capture and check awk separately: a read/extraction error must never become N/A
# or be hidden by grep finding a label in partial output. Ignore fenced examples.
if ! section=$(awk '
  {
    sub(/\r$/, "")
    if ($0 ~ /^[[:blank:]]*(```|~~~)/) {
      marker = $0
      sub(/^[[:blank:]]*/, "", marker)
      char = substr(marker, 1, 1)
      run = 0
      while (substr(marker, run + 1, 1) == char) run++
      rest = substr(marker, run + 1)
      if (fence == "") {
        fence = char
        fence_length = run
      } else if (char == fence && run >= fence_length && rest ~ /^[[:blank:]]*$/) {
        fence = ""
      }
      next
    }
    if (fence != "") next
    if ($0 ~ /^## Previous Recommendations Review[[:blank:]]*$/) {
      sections++
      inside = 1
      next
    }
    if ($0 ~ /^##?([[:blank:]]|$)/) inside = 0
    if (inside) print
  }
  END { if (sections != 1) exit 1 }
' < "$report"); then
  fail 'could not read report or extract exactly one canonical review section'
fi

case "$mode" in
  required)
    # Whole-field anchors prevent Pending from matching Pending+Deadline suffixes,
    # ClosedLoop, or a vocabulary list. The literal plus must be escaped in ERE.
    pattern='^- Status:[[:blank:]]+(Closed|Moot|Pending|Pending\+Deadline|Failure-Mode)[[:blank:]]*$'
    ;;
  first-run)
    pattern='^- Not applicable: first reflection run; no prior recommendations to review\.[[:blank:]]*$'
    ;;
  empty-prior)
    pattern='^- Not applicable: prior recommendations list is empty\.[[:blank:]]*$'
    ;;
esac

# Do not use grep -q: consume all input so pipe errors cannot be masked or caused
# by an early successful match. Both non-match and command errors fail closed.
if ! printf '%s\n' "$section" | grep -E "$pattern" > /dev/null; then
  fail "missing required status/N/A field or grep error (mode: $mode)"
fi
printf 'Previous Recommendations Review validation passed (mode: %s)\n' "$mode"
