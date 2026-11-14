#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the row/entry-count-scaled threshold math
 * (poller-brain#324, poller-brain#300, poller-brain#536).
 * Pure math fixtures plus real trim output passed through the threshold CLI.
 *
 * Run: npx tsx skills/memory/scripts/mem-scaled-threshold.test.ts
 * Exits non-zero if any assertion fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { applyTrimCandidates, findTrimCandidates, verifyTrimStats } from "./lib/mem-registry-trim-core.js";
import {
  countRegistryRows,
  evaluate,
  evaluateRegistry,
  scaledThreshold,
  BASE_FLOOR_BYTES,
  REGISTRY_OVERHEAD_BYTES,
  REGISTRY_PER_ROW_BYTES,
  LEARNINGS_OVERHEAD_BYTES,
  LEARNINGS_PER_ENTRY_BYTES,
} from "./lib/mem-scaled-threshold-core.js";
import { countLearningsEntries } from "./lib/mem-learnings-trim-core.js";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    failed++;
    return;
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

// Both forms are complete registry identities; malformed dated prefixes are not rows.
const DATED_A = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DATED_B = "MEM-2026-11-07-203001-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";

const mixedRows = REGISTRY + `| ${DATED_A} | ACTIVE | x | — | a |\n| ${DATED_B} | REMOVED | x | — | b |\n`;
assert(countRegistryRows(mixedRows) === 5, "counts legacy and both distinct dated rows");
assert(countRegistryRows(`| ${DATED_A.toUpperCase()} | ACTIVE | x |\n`) === 1, "uppercase UUID row counts");
assert(countRegistryRows("| MEM-2026-11-07-broken | ACTIVE | x |\n") === 0, "malformed dated ID is not a numeric row");

// #536: exercise the actual discover/coverage/apply writer, then the CLI that
// Step 9b and the 9d/9e gates use. No hand-written approximation of trim output.
const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-threshold-"));
fs.mkdirSync(path.join(cliRoot, "memory/core"), { recursive: true });
fs.writeFileSync(path.join(cliRoot, "CLAUDE.md"), "# Isolated test brain\n");
function runCli(text: string | null, mode = "registry") {
  const file = path.join(cliRoot, mode === "registry" ? "memory/MEM_REGISTRY.md" : "memory/core/LEARNINGS.md");
  if (text === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, text);
  const child = spawnSync(process.execPath,
    [...process.execArgv, path.resolve("skills/memory/scripts/mem-scaled-threshold.ts"), "--mode", mode],
    { env: { ...process.env, BRAIN_ROOT: cliRoot }, encoding: "utf8" });
  assert(child.status === 0, `threshold CLI succeeds: ${child.stderr}`);
  const lines = child.stdout.trim().split("\n");
  return { result: JSON.parse(lines[lines.length - 1]), output: child.stdout };
}
function fixtureId(index: number, kind: string) {
  return kind === "legacy" || (kind === "mixed" && index % 2 === 0)
    ? `MEM-${index + 1}`
    : `MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-${index.toString(16).padStart(12, "0")}`;
}
function trimFixture(columns: number, kind: string, file: string, hook: string) {
  const descriptions = Array.from({ length: 186 }, (_, i) =>
    `Preserve the complete deployment rule number ${i}: ` + "Verify the reviewed release before starting the rollout. ".repeat(80));
  const registry = `# MEM Registry\n\n| Key | Status | Created | ${columns === 5 ? "Obsoleted | " : ""}Description |\n` +
    `|---|---|---|${columns === 5 ? "---|" : ""}---|\n` +
    descriptions.map((body, i) => `| ${fixtureId(i, kind)} | ACTIVE | 2026-11-07 | ${columns === 5 ? "— | " : ""}${body} |\n`).join("");
  const destinations = [{ file, text: `# ${hook}\n\n` +
    descriptions.map((body, i) => `[${fixtureId(i, kind)}] ${body}`).join("\n") }];
  const found = findTrimCandidates(registry, destinations);
  assert(found.candidates.length === 186, "real discovery finds every covered row");
  const trimmed = applyTrimCandidates(registry, found.candidates);
  assert(trimmed.stats.trimmedRows === 186, "real writer trims every row");
  assert(verifyTrimStats(trimmed.stats).length === 3, "real trim passes no-growth/count verification");
  assert(applyTrimCandidates(trimmed.registry, found.candidates).registry === trimmed.registry, "real trim output is idempotent");
  return trimmed.registry;
}
try {
  const hook = "Verify the reviewed deployment before starting another rollout."; // 62 UTF-8 bytes
  for (const columns of [4, 5]) {
    for (const kind of ["legacy", "dated", "mixed"]) {
      for (const file of ["core/rules.md", "semantic/" + "long-destination-directory/".repeat(8) + "release-rules.md"]) {
        const registry = trimFixture(columns, kind, file, hook);
        const { result } = runCli(registry);
        const label = `${columns} columns, ${kind} IDs, ${Buffer.byteLength(file)}B path`;
        assert(result.entryCount === 186, `${label}: CLI counts real trim output`);
        assert(result.sizeBytes === Buffer.byteLength(registry), `${label}: CLI measures UTF-8 bytes`);
        assert(!result.overCap, `${label}: real trim output fits (${result.sizeBytes}B <= ${result.threshold}B)`);
        console.log(`#536 ${label}: ${result.sizeBytes}B / ${result.threshold}B, ${result.overCap ? "OVER" : "OK"}`);
      }
    }
  }
  const escapedUnicode = trimFixture(5, "mixed", "semantic/部署/" + "長い\\|経路/".repeat(12) + "rules.md", "Validate the café deployment before starting another rollout.");
  assert(!runCli(escapedUnicode).result.overCap, "UTF-8 and escaped pipes in real pointer paths fit");
  // Hooks come from headings and currently have NO length cap. The guarantee
  // covers these too, without adding an allowance to non-pointer prose.
  for (const columns of [4, 5]) {
    const registry = trimFixture(columns, "dated", "semantic/rules.md",
      "Validate 部署 café \\| details in guide.md — " + "Preserve every reviewed deployment constraint. ".repeat(20));
    const { result } = runCli(registry);
    assert(!result.overCap && result.pointerRows === 186, `${columns} columns: unbounded real heading hooks fit`);
  }
  const verboseRows = Array.from({ length: 186 }, (_, i) =>
    `| MEM-${i + 1} | ACTIVE | 2026-11-07 | — | ${"Verbose narrative about deployment details. ".repeat(40)} |\n`).join("");
  const verbose = runCli(verboseRows);
  assert(verbose.result.overCap && verbose.output.includes("OVER CAP"), "non-pointer prose-heavy registry still warns");
  const proseHeavy = runCli("# Policy\n" + "Embedded policy prose. ".repeat(500));
  assert(proseHeavy.result.overCap, "non-row prose never scales its own allowance");
  const mixed = runCli(escapedUnicode + verboseRows);
  assert(mixed.result.pointerRows === 186 && mixed.result.nonPointerRows === 186 && mixed.result.overCap,
    "mixed pointer/narrative registry still warns for the verbose non-pointer portion");
  const missing = runCli(null).result;
  assert(missing.sizeBytes === 0 && missing.entryCount === 0 && missing.threshold === 5000 && !missing.overCap, "missing registry preserves skip/floor result");
  assert(runCli("").result.threshold === 5000, "empty registry keeps the floor");
  assert(!runCli("x".repeat(5000)).result.overCap, "equality at the threshold is OK");
  assert(runCli("x".repeat(5001)).result.overCap, "one byte over the threshold warns");
  const learnings = runCli(bulletLearnings, "learnings").result;
  assert(JSON.stringify(learnings) === JSON.stringify(learningsEval), "learnings CLI policy is unchanged");

  const pointer = `| ${DATED_A} | PROMOTED | 2026-11-07 | semantic/${"long-path/".repeat(12)}rules.md:12345 | see semantic/${"long-path/".repeat(12)}rules.md — Validated deployment rule |\n`;
  const pointerBudget = evaluateRegistry(pointer.repeat(50));
  assert(pointerBudget.pointerRows === 50 && pointerBudget.nonPointerRows === 0 && pointerBudget.diagnostics.length === 0,
    "custom lifecycle status and large line numbers retain pointer structure");
  assert(pointerBudget.threshold === 300 + Buffer.byteLength(pointer.repeat(50)), "structural budget counts both path occurrences and line digits exactly");
  assert(!evaluateRegistry(pointer.repeat(50) + "x".repeat(300)).overCap, "equality at the structural cap is OK");
  assert(evaluateRegistry(pointer.repeat(50) + "x".repeat(301)).overCap, "excess prose still warns alongside structural pointer allowances");
  const crlf = pointer.replace(/\n/g, "\r\n");
  assert(evaluateRegistry(crlf.repeat(50)).threshold === 300 + Buffer.byteLength(crlf.repeat(50)), "CRLF bytes count exactly once");
  const noFinalNewline = pointer.repeat(50).trimEnd();
  assert(evaluateRegistry(noFinalNewline).threshold === 300 + Buffer.byteLength(noFinalNewline), "absent final newline does not earn an extra byte");
  const mismatch = pointer.replace("see semantic/", "see other/");
  const malformed = "| MEM-1 | ACTIVE | 2026-11-07 | extra | extra | Too many columns |\n";
  const badRows = runCli(mismatch.repeat(50) + malformed).result;
  assert(badRows.entryCount === 51 && badRows.pointerRows === 0 && badRows.rowBudgetBytes === 51 * 150,
    "mismatched pointers and malformed rows fall back to the legacy allowance");
  assert(badRows.diagnostics.length === 51 && badRows.diagnostics[50].line === 51,
    "malformed-row diagnostics retain source line numbers through the CLI");
  assert(badRows.overCap, "malformed pointer-like rows cannot inflate their allowance");
  assert(evaluateRegistry(pointer.replace(" — ", " - ")).pointerRows === 1, "legacy dash pointer encoding remains supported");
  assert(evaluateRegistry(REGISTRY).rowBudgetBytes === 3 * 150, "ordinary narrative rows retain the old allowance");
  assert(evaluateRegistry(mixedRows).entryCount === countRegistryRows(mixedRows), "structural evaluator counts the same complete IDs as the existing counter");
} finally {
  fs.rmSync(cliRoot, { recursive: true, force: true });
}

console.log(`${passed} assertions passed, ${failed} failed`);
if (failed) process.exitCode = 1;
