#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for --source= flag parsing (parseSourceFlag).
 *
 * Run: npx tsx skills/memory/scripts/source-flag.test.ts
 * Exits non-zero on the first failed assertion.
 */

import { parseSourceFlag, sourceTag } from "./lib/source-flag.js";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

// --- no flag: defaults to maintenance (fail-safe direction) ----------------
{
  const parsed = parseSourceFlag(["health-check: klidný den"]);
  assert(parsed.source === "maintenance", "missing flag must default to maintenance");
  assert(parsed.content === "health-check: klidný den", "content unaffected when no flag present");
}

// --- explicit user-session flag ---------------------------------------------
{
  const parsed = parseSourceFlag(["--source=user-session", "triage: 3 nové emaily"]);
  assert(parsed.source === "user-session", "explicit flag must be honored");
  assert(parsed.content === "triage: 3 nové emaily", "flag arg must be stripped from content");
}

// --- explicit maintenance flag (redundant with default, still valid) -------
{
  const parsed = parseSourceFlag(["--source=maintenance", "consolidation session"]);
  assert(parsed.source === "maintenance", "explicit maintenance flag must be honored");
  assert(parsed.content === "consolidation session", "flag arg must be stripped from content");
}

// --- flag position is order-agnostic ----------------------------------------
{
  const parsed = parseSourceFlag(["triage: 3 nové emaily", "--source=user-session"]);
  assert(parsed.source === "user-session", "flag must be recognized regardless of position");
  assert(parsed.content === "triage: 3 nové emaily", "content must not include a trailing flag");
}

// --- invalid flag value throws, does not silently become content -----------
{
  let threw = false;
  try {
    parseSourceFlag(["--source=bogus", "some content"]);
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("bogus"),
      "error message must name the invalid value"
    );
  }
  assert(threw, "invalid --source value must throw, not silently pass through as content");
}

// --- sourceTag mapping -------------------------------------------------------
{
  assert(sourceTag("maintenance") === "[maint]", "maintenance tag must be [maint]");
  assert(sourceTag("user-session") === "[user]", "user-session tag must be [user]");
}

console.log(`✅ all ${passed} assertions passed`);
