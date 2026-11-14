#!/bin/bash
# Returns 0 for promotion evidence or malformed/unreadable coverage (not idle).
# Returns 1 only for a complete block without promotion evidence. Callers pass
# the extracted Tier Coverage section, so references elsewhere do not count.
tier_coverage_promoted() {
  # Invert the zero-promotion result so classifier errors also break idleness.
  ! LC_ALL=C awk '
    /^- / { tiers++ }
    /[A-Za-z0-9_.\/-]+\.md/ || /MEM-[0-9]/ || tolower($0) ~ /updated/ { promoted=1 }
    END { exit (tiers >= 4 && !promoted ? 0 : 1) }
  ' <<< "$1"
}
