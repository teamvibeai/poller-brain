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

import { getNextKeyFromContents, truncateRegistryDescription, MAX_REGISTRY_DESC_LENGTH } from "./lib/mem-write-core.js";

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

// --- registry description truncation (pb#283) -------------------------------

// short content passes through unchanged, no pointer added
{
  const desc = truncateRegistryDescription("deploy: staging vyžaduje SSO login", "memory/daily/2026-08-07.md");
  assert(
    desc === "deploy: staging vyžaduje SSO login",
    `short desc must be unchanged, got: ${desc}`
  );
}

// content over the cap is truncated and gains a pointer, staying within budget
{
  const long = "x".repeat(500);
  const desc = truncateRegistryDescription(long, "memory/daily/2026-08-07.md");
  assert(
    desc.length <= MAX_REGISTRY_DESC_LENGTH,
    `truncated desc must respect the ${MAX_REGISTRY_DESC_LENGTH}B cap, got ${desc.length}B`
  );
  assert(
    desc.includes("[full: memory/daily/2026-08-07.md]"),
    `truncated desc must carry a pointer to the daily log, got: ${desc}`
  );
  assert(desc.startsWith("x"), `truncated desc must retain a content prefix, got: ${desc}`);
}

// content exactly at the cap is unchanged (boundary, no off-by-one)
{
  const exact = "y".repeat(MAX_REGISTRY_DESC_LENGTH);
  const desc = truncateRegistryDescription(exact, "memory/daily/2026-08-07.md");
  assert(desc === exact, `desc exactly at cap must be unchanged, got length ${desc.length}`);
}

// byte-aware cap: Czech diacritics are 2B each in UTF-8, so a string whose
// JS .length is under the cap can still exceed it in bytes (DevGuru review,
// pb#283) -- the truncated output must respect the BYTE budget, not code units
{
  const czech = "č".repeat(280); // 280 code units, but 560B in UTF-8
  const desc = truncateRegistryDescription(czech, "memory/daily/2026-08-07.md");
  const byteLen = Buffer.byteLength(desc, "utf8");
  assert(
    byteLen <= MAX_REGISTRY_DESC_LENGTH,
    `truncated desc must respect the ${MAX_REGISTRY_DESC_LENGTH}B cap in BYTES, got ${byteLen}B (desc.length=${desc.length})`
  );
  assert(
    desc.includes("[full: memory/daily/2026-08-07.md]"),
    `truncated desc must carry a pointer to the daily log, got: ${desc}`
  );
}

// a diacritic-heavy description just under the cap in .length but over it in
// bytes must still be truncated (this is the exact false-negative DevGuru flagged)
{
  const czech300 = "ř".repeat(MAX_REGISTRY_DESC_LENGTH); // .length === 300, but 600B
  const desc = truncateRegistryDescription(czech300, "memory/daily/2026-08-07.md");
  assert(
    desc !== czech300,
    `a 300-char all-diacritic desc is 600B and must be truncated, not passed through unchanged`
  );
  const byteLen = Buffer.byteLength(desc, "utf8");
  assert(byteLen <= MAX_REGISTRY_DESC_LENGTH, `truncated output must fit the ${MAX_REGISTRY_DESC_LENGTH}B cap, got ${byteLen}B`);
}

console.log(`✅ all ${passed} assertions passed`);
