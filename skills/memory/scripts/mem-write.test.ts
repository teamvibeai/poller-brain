#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the MEM-key counter logic (getNextKeyFromContents).
 *
 * Targets the 2026-06-08 incident class: a silent over-match on a prose
 * mention of a MEM key (e.g. "...covered by MEM-78 above...") inflating the
 * counter past the next real canonical key.
 *
 * Run: npx tsx skills/memory/scripts/mem-write.test.ts
 * Exits non-zero on the first failed assertion.
 */

import { getNextKeyFromContents } from "./lib/mem-write-core.js";
import { computeRollover } from "./lib/today-md-core.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// --- prose mention must NOT move the counter --------------------------------
{
  const today = `# 2026-06-08

- [09:00] review: this incident traces back to MEM-78 and a related fix.
- [MEM-3] deploy: staging vyžaduje SSO login
`;
  const key = getNextKeyFromContents("", "", today);
  assert(
    key === 4,
    `prose mention of MEM-78 must not count — expected next key 4, got ${key}`
  );
}

// --- colon-variant canonical row IS counted (format drift tolerance) -------
{
  const today = `# 2026-06-09

- [MEM-3] deploy: staging vyžaduje SSO login
- [MEM-5]: komunikace, mužský rod
`;
  const key = getNextKeyFromContents("", "", today);
  assert(
    key === 6,
    `colon-variant canonical row must be counted — expected next key 6, got ${key}`
  );
}

// --- registry pipe-table rows are scanned regardless of TODAY.md state -----
{
  const registry = `# MEM Registry

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-9 | ACTIVE | 2026-06-01 | — | some entry |
`;
  const key = getNextKeyFromContents(registry, "", "");
  assert(
    key === 10,
    `registry table row must be scanned — expected next key 10, got ${key}`
  );
}

// --- archive rows (REMOVED, relocated out of the live registry) still count -
{
  const registry = `| MEM-4 | ACTIVE | 2026-06-01 | — | still live |\n`;
  const archive = `| MEM-12 | REMOVED | 2026-05-01 | 2026-05-25 | superseded |\n`;
  const key = getNextKeyFromContents(registry, archive, "");
  assert(
    key === 13,
    `archived key must not be reused — expected next key 13, got ${key}`
  );
}

// --- the max across all three sources wins ---------------------------------
{
  const registry = `| MEM-5 | ACTIVE | 2026-06-01 | — | x |\n`;
  const archive = `| MEM-2 | REMOVED | 2026-05-01 | 2026-05-25 | y |\n`;
  const today = `- [MEM-20] deploy: z\n`;
  const key = getNextKeyFromContents(registry, archive, today);
  assert(key === 21, `overall max must win — expected next key 21, got ${key}`);
}

// --- all-empty inputs (fresh brain) start at 1 -----------------------------
{
  const key = getNextKeyFromContents("", "", "");
  assert(key === 1, `fresh brain must start at key 1, got ${key}`);
}

// --- mem-write.ts must roll over a stale TODAY.md header too (poller-brain#267:
// mem-write.ts historically only handled the file-missing case, never the
// stale-header case that log-write.ts already covers via the same function) --
{
  const content = "# 2026-07-28\n\n- [MEM-3] deploy: staging vyžaduje SSO login\n";
  const action = computeRollover(content, "2026-07-29");
  assert(
    action.kind === "append-header",
    "mem-write.ts's ensureToday must roll a stale header on a new UTC day"
  );
  assert(
    action.textToWrite === "\n# 2026-07-29\n\n",
    "rollover must append a fresh dated section, not rewrite history"
  );
}

// --- same-day mem-write.ts call must not duplicate the header --------------
{
  const content = "# 2026-07-29\n\n- [MEM-3] deploy: staging vyžaduje SSO login\n";
  const action = computeRollover(content, "2026-07-29");
  assert(action.kind === "none", "same-day mem-write.ts call must be a no-op");
}

console.log(`✅ all ${passed} assertions passed`);
