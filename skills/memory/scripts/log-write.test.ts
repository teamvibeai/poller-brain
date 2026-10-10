#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the log-write.ts date-rollover logic
 * (computeRollover).
 *
 * Covers the day-boundary branch: a new day must start a fresh "# YYYY-MM-DD"
 * section, checked against the LAST header (not the first) so a same-day
 * call after an earlier rollover does not append a duplicate section.
 *
 * Run: npx tsx skills/memory/scripts/log-write.test.ts
 * Exits non-zero on the first failed assertion.
 */

import { computeRollover } from "./lib/today-md-core.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// --- missing file: create with today's header ------------------------------
{
  const action = computeRollover(null, "2026-07-29");
  assert(action.kind === "create", "missing file must create");
  assert(
    action.textToWrite === "# 2026-07-29\n\n",
    "create must write today's header"
  );
}

// --- same-day call: no rollover ---------------------------------------------
{
  const content = "# 2026-07-29\n\n- [09:00] some entry\n";
  const action = computeRollover(content, "2026-07-29");
  assert(action.kind === "none", "same-day call must be a no-op");
}

// --- new day: append a fresh header ------------------------------------------
{
  const content = "# 2026-07-28\n\n- [23:59] end of day entry\n";
  const action = computeRollover(content, "2026-07-29");
  assert(action.kind === "append-header", "new day must append a header");
  assert(
    action.textToWrite === "\n# 2026-07-29\n\n",
    "append must be a new section, leading blank line included"
  );
}

// --- multiple headers already present: only the LAST one matters -----------
{
  // Simulates a file that already rolled over earlier in the session; a
  // second same-day call must not re-append a duplicate section.
  const content =
    "# 2026-07-28\n\n- [23:00] entry\n\n# 2026-07-29\n\n- [00:05] entry\n";
  const action = computeRollover(content, "2026-07-29");
  assert(
    action.kind === "none",
    "must check the LAST header, not the first — no duplicate section"
  );
}

console.log(`✅ all ${passed} assertions passed`);
