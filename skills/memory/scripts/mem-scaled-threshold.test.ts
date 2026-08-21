#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the row/entry-count-scaled threshold math
 * (poller-brain#324, poller-brain#300). No fs — pure string fixtures.
 *
 * Run: npx tsx skills/memory/scripts/mem-scaled-threshold.test.ts
 * Exits non-zero on the first failed assertion.
 */

import {
  countRegistryRows,
  evaluate,
  scaledThreshold,
  BASE_FLOOR_BYTES,
  REGISTRY_OVERHEAD_BYTES,
  REGISTRY_PER_ROW_BYTES,
  LEARNINGS_OVERHEAD_BYTES,
  LEARNINGS_PER_ENTRY_BYTES,
} from "./lib/mem-scaled-threshold-core.js";
import { countLearningsEntries } from "./lib/mem-learnings-trim-core.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// --- scaledThreshold: floor + formula -----------------------------------
assert(scaledThreshold(0, 300, 150) === BASE_FLOOR_BYTES, "0 rows still floors at BASE_FLOOR_BYTES");
assert(scaledThreshold(5, 300, 150) === BASE_FLOOR_BYTES, "a handful of rows stays under the floor");
assert(scaledThreshold(58, 300, 150) === 300 + 58 * 150, "high row count scales past the floor");

// --- countRegistryRows -----------------------------------------------------
const REGISTRY = `# MEM Registry

## HOLD lifecycle rule

- **REMOVE** → set status REMOVED with justification (this prose line must NOT count as a row).

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-1 | ACTIVE | 2026-04-29 | — | keep me active |
| MEM-2 | REMOVED | 2026-04-29 | 2026-05-25 | superseded by MEM-7 |
| MEM-4 | OBSOLETE | 2026-05-01 | 2026-05-25 | pending removal next cycle |
`;
assert(countRegistryRows(REGISTRY) === 3, "counts only table data rows, not prose mentioning REMOVED");
assert(countRegistryRows("# MEM Registry\n\nno table yet\n") === 0, "no rows on a table-less registry");

// --- poller-brain#324's own measured tina-kb case: floor is unreachable at flat 5000B,
// reachable once scaled by row count -----------------------------------------------
const tinaKbRows = 58;
const tinaKbFloorBytes = 5161; // measured: every row already at its shortest practical form
const flatCap = 5000;
assert(tinaKbFloorBytes > flatCap, "sanity: reproduces #324's finding that the flat cap is unreachable");
const scaled = scaledThreshold(tinaKbRows, REGISTRY_OVERHEAD_BYTES, REGISTRY_PER_ROW_BYTES);
assert(scaled > tinaKbFloorBytes, "scaled threshold clears the measured practical floor for 58 rows");

// --- evaluate() wiring -------------------------------------------------------------
const smallRegistry = "| Key | Status | Created | Obsoleted | Description |\n|-|-|-|-|-|\n| MEM-1 | ACTIVE | 2026-01-01 | — | x |\n";
const evalResult = evaluate(smallRegistry, countRegistryRows(smallRegistry), REGISTRY_OVERHEAD_BYTES, REGISTRY_PER_ROW_BYTES);
assert(evalResult.entryCount === 1, "evaluate() uses the passed-in row count");
assert(evalResult.threshold === BASE_FLOOR_BYTES, "single-row file still floors at the base cap");
assert(evalResult.overCap === false, "tiny well-formed registry is not over cap");

// --- countLearningsEntries (reused from mem-learnings-trim-core, both bullet and heading shape) ---
const bulletLearnings = `# Learnings

- **rule one** — because reasons. (Source: X, 2026-01-01)
- **rule two** — because other reasons. (Source: Y, 2026-01-02)
`;
assert(countLearningsEntries(bulletLearnings) === 2, "counts bullet-format entries");

const headingLearnings = `# Learnings

### Rule One
**Rule:** do the thing.
**Why:** reasons.

### Rule Two
**Rule:** do the other thing.
**Why:** other reasons.
`;
assert(countLearningsEntries(headingLearnings) === 2, "counts heading-format entries");

const learningsEval = evaluate(
  bulletLearnings,
  countLearningsEntries(bulletLearnings),
  LEARNINGS_OVERHEAD_BYTES,
  LEARNINGS_PER_ENTRY_BYTES
);
assert(learningsEval.entryCount === 2, "learnings evaluate() picks up entry count via the shared parser");

// --- DevGuru's caught regression case: a real 4th-brain sample (24110B, 84 entries) flipped
// OVER->OK under the old unanchored 400B/entry guess. The derived-from-real-pointer-data 150B
// must NOT flip it — this pins that down as a regression test. -----------------------------
const devguruSampleThreshold = scaledThreshold(84, LEARNINGS_OVERHEAD_BYTES, LEARNINGS_PER_ENTRY_BYTES);
assert(devguruSampleThreshold < 24110, "DevGuru's 84-entry/24110B sample must stay OVER cap, not flip to OK");

console.log(`✅ all ${passed} assertions passed`);
