#!/bin/bash
# Returns 0 for promotion evidence or malformed/unreadable coverage (not idle).
# Returns 1 only when all four named tiers positively confirm no change.
# Callers pass the extracted Tier Coverage section, so references elsewhere
# do not count. Unknown statuses cannot establish idleness in any language.
tier_coverage_promoted() {
  # Invert confirmed idleness so awk errors also break the idle streak.
  ! LC_ALL=C awk '
    { sub(/\r$/, "") }
    /[A-Za-z0-9_.\/-]+\.md/ || /MEM-[0-9]/ || tolower($0) ~ /updated/ { promoted=1 }
    /^## Tier Coverage/ || /^[[:space:]]*$/ { next }
    /^[[:space:]]*-[[:space:]]+/ {
      line=$0
      sub(/^[[:space:]]*-[[:space:]]+/, "", line)
      if (line !~ /^(memory\/)?(core|semantic|episodic|procedural)\/([[:space:]]+\([^)]*\))?[[:space:]]*:/) {
        ambiguous=1
        next
      }
      tier=line
      sub(/^memory\//, "", tier)
      sub(/\/.*/, "", tier)
      sub(/^[^:]*:[[:space:]]*/, "", line)
      if (tolower(line) ~ /^no (new content|significant events|new workflows)[[:space:]]+—[[:space:]]+confirmed([[:space:]]+✅)?[[:space:]]*$/) {
        idle[tier]=1
      } else {
        ambiguous=1
      }
      next
    }
    { ambiguous=1 }
    END { exit (idle["core"] && idle["semantic"] && idle["episodic"] && idle["procedural"] && !promoted && !ambiguous ? 0 : 1) }
  ' <<< "$1"
}
