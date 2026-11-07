#!/usr/bin/env npx tsx
/**
 * Fixture-based self-test for the MEM_REGISTRY archival logic.
 *
 * Runs the DevGuru count-verify conditions against string fixtures (no fs):
 *   - round-trip identity: every REMOVED row relocated is present in archive
 *   - count: removedFromLive == newlyArchived + alreadyInArchive
 *   - live REMOVED count after run == 0
 *   - idempotence: a second run is a byte-identical no-op
 *   - prose containing the word "REMOVED" is never touched
 *   - ACTIVE / OBSOLETE rows and header prose are preserved
 *
 * Run: npx tsx skills/memory/scripts/mem-registry-archive.test.ts
 * Exits non-zero if any assertion fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  archiveRemovedRows,
  verifyStats,
} from "./lib/mem-registry-archive-core.js";

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

// A fixture that mirrors the real registry shape: prose sections that mention
// "REMOVED" in text (must NOT be relocated) + a 5-column table with a mix of
// ACTIVE / OBSOLETE / REMOVED rows.
const REGISTRY = `# MEM Registry

## HOLD lifecycle rule

- **REMOVE** → set status REMOVED with brief justification (this prose line mentions REMOVED and must stay).

| Key | Status | Created | Obsoleted | Description |
|-----|--------|---------|-----------|-------------|
| MEM-1 | ACTIVE | 2026-04-29 | — | keep me active |
| MEM-2 | REMOVED | 2026-04-29 | 2026-05-25 | superseded by MEM-7 |
| MEM-3 | REMOVED | 2026-04-30 | 2026-05-25 | superseded by MEM-10 |
| MEM-4 | OBSOLETE | 2026-05-01 | 2026-05-25 | pending removal next cycle |
| MEM-5 | REMOVED | 2026-05-04 | 2026-05-25 | moved to semantic/ |
`;

// --- Run 1: fresh archive ---------------------------------------------------
const r1 = archiveRemovedRows(REGISTRY, "");
const c1 = verifyStats(r1.stats);

assert(r1.stats.removedFromLive === 3, "should find 3 REMOVED rows");
assert(r1.stats.newlyArchived === 3, "should newly archive 3 rows");
assert(r1.stats.alreadyInArchive === 0, "nothing pre-archived on fresh run");
assert(r1.stats.liveRemovedAfter === 0, "no REMOVED rows left in live registry");
assert(r1.stats.missing.length === 0, "no round-trip misses");
assert(
  r1.stats.archivedKeys.join(",") === "MEM-2,MEM-3,MEM-5",
  "relocated the correct keys"
);
assert(c1.length === 3, "all 3 verify checks passed");
assert(c1[2] === "live REMOVED count after run == 0 ✅", "zero-conflict verification line matches base exactly");

// Live registry keeps ACTIVE + OBSOLETE, drops REMOVED, prose intact.
assert(/\| MEM-1 \| ACTIVE/.test(r1.registry), "ACTIVE row kept");
assert(/\| MEM-4 \| OBSOLETE/.test(r1.registry), "OBSOLETE row kept");
assert(!/\| MEM-2 \| REMOVED/.test(r1.registry), "REMOVED MEM-2 removed from live");
assert(!/\| MEM-3 \| REMOVED/.test(r1.registry), "REMOVED MEM-3 removed from live");
assert(!/\| MEM-5 \| REMOVED/.test(r1.registry), "REMOVED MEM-5 removed from live");
assert(
  /- \*\*REMOVE\*\* → set status REMOVED/.test(r1.registry),
  "prose line mentioning REMOVED is preserved"
);

// Stub is a pointer with count + link + keys.
assert(
  /> 📦 3 REMOVED audit entries archived to \[MEM_REGISTRY_ARCHIVE\.md\]\(MEM_REGISTRY_ARCHIVE\.md\) — Keys: MEM-2, MEM-3, MEM-5/.test(
    r1.registry
  ),
  "stub pointer present with count, link, and key list"
);
assert((r1.registry.match(/📦/g) || []).length === 1, "exactly one stub line");

// Archive holds every relocated row verbatim.
for (const key of ["MEM-2", "MEM-3", "MEM-5"]) {
  assert(
    new RegExp(`\\| ${key} \\| REMOVED`).test(r1.archive),
    `${key} present in archive`
  );
}

// --- Run 2: idempotence — feed run-1 output back in -------------------------
const r2 = archiveRemovedRows(r1.registry, r1.archive);
verifyStats(r2.stats);
assert(r2.stats.removedFromLive === 0, "run 2 finds no REMOVED rows");
assert(r2.stats.newlyArchived === 0, "run 2 archives nothing new");
assert(
  r2.registry === r1.registry,
  "run 2 registry is byte-identical (idempotent)"
);
assert(r2.archive === r1.archive, "run 2 archive is byte-identical (idempotent)");

// --- Run 3: a NEW removal on top of an existing archive ---------------------
const registryWithNewRemoval = r1.registry.replace(
  "| MEM-4 | OBSOLETE | 2026-05-01 | 2026-05-25 | pending removal next cycle |",
  "| MEM-4 | REMOVED | 2026-05-01 | 2026-06-30 | removed this cycle |"
);
const r3 = archiveRemovedRows(registryWithNewRemoval, r1.archive);
verifyStats(r3.stats);
assert(r3.stats.removedFromLive === 1, "run 3 finds the 1 new REMOVED row");
assert(r3.stats.newlyArchived === 1, "run 3 archives 1 new row");
assert(r3.stats.totalArchived === 4, "archive now holds 4 keys");
assert(r3.stats.liveRemovedAfter === 0, "no REMOVED rows left after run 3");
assert(
  /> 📦 4 REMOVED audit entries .* Keys: MEM-2, MEM-3, MEM-4, MEM-5/.test(
    r3.registry
  ),
  "stub count + keys updated after new removal"
);

// --- Run 4: partial re-run — same removed row already in archive ------------
// Simulates a crash-between-writes: live still has a REMOVED row that already
// made it to the archive. Must not duplicate, must still clear it from live.
const r4 = archiveRemovedRows(registryWithNewRemoval, r3.archive);
verifyStats(r4.stats);
assert(r4.stats.alreadyInArchive === 1, "already-archived row detected");
assert(r4.stats.newlyArchived === 0, "no duplicate append");
assert(r4.stats.liveRemovedAfter === 0, "live row still cleared");
assert(
  (r4.archive.match(/\| MEM-4 \| REMOVED/g) || []).length === 1,
  "MEM-4 not duplicated in archive"
);

// Mixed formats relocate verbatim; conflicting content is retained for explicit repair.
const DATED_A = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DATED_B = "MEM-2026-11-07-203001-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";

const datedRow = `| ${DATED_A} | REMOVED | 2026-11-07 | — | original dated memo |`;
const otherRow = `| ${DATED_B} | REMOVED | 2026-11-07 | — | second dated memo |`;
const legacyRow = "| MEM-12 | REMOVED | 2026-11-07 | — | legacy memo |";
const mixedArchive = archiveRemovedRows([otherRow, legacyRow, datedRow].join("\n"), "");
verifyStats(mixedArchive.stats);
assert(mixedArchive.stats.newlyArchived === 3, "archives all mixed-format REMOVED rows");
assert(mixedArchive.archive.includes(datedRow) && mixedArchive.archive.includes(otherRow), "dated rows archived verbatim");
assert(mixedArchive.stats.archivedKeys.join(",") === ["MEM-12", DATED_A, DATED_B].join(","), "archive keys use mixed-format ordering");
assert(!mixedArchive.registry.includes(datedRow), "dated REMOVED row leaves live table");
const caseDistinct = archiveRemovedRows(datedRow + "\n" + datedRow.replace(DATED_A, DATED_A.slice(0, 22) + DATED_A.slice(22).toUpperCase()), "");
assert(caseDistinct.stats.newlyArchived === 2 && caseDistinct.stats.totalArchived === 2, "UUID case spellings remain separate archive identities");
const liveConflict = archiveRemovedRows(datedRow + "\n" + datedRow.replace("original", "different"), "");
verifyStats(liveConflict.stats);
assert(liveConflict.registry.includes(datedRow.replace("original", "different")) && liveConflict.archive.includes(datedRow),
  "same-run archival never suppresses a later conflicting live row");
const identicalDated = archiveRemovedRows(datedRow, mixedArchive.archive);
assert(identicalDated.stats.alreadyInArchive === 1 && identicalDated.stats.liveRemovedAfter === 0,
  "identical dated archive row retains existing suppression behavior");
for (const row of [datedRow, legacyRow]) {
  const conflicting = row.replace("memo |", "memo with different content |");
  const result = archiveRemovedRows([conflicting, otherRow].join("\n"), row + "\n");
  assert(verifyStats(result.stats)[2] === "live REMOVED count after run == 1 retained conflicting row(s) ✅",
    "conflict verification line reports retained count");
  assert(result.registry.split("\n").includes(conflicting), "conflicting same-ID live row stays verbatim");
  assert(!result.archive.includes(conflicting), "conflicting row is not appended or substituted in archive");
  assert(result.stats.liveRemovedAfter === 1 && result.stats.removedFromLive === 1, "only nonconflicting row relocated");
  const repeat = archiveRemovedRows(result.registry, result.archive);
  verifyStats(repeat.stats);
  assert(repeat.registry === result.registry && repeat.archive === result.archive, "conflict repeat run is byte-identical");
}
const conflictRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-id-archive-"));
try {
  fs.mkdirSync(path.join(conflictRoot, "memory"));
  fs.writeFileSync(path.join(conflictRoot, "CLAUDE.md"), "fixture");
  fs.writeFileSync(path.join(conflictRoot, "memory/MEM_REGISTRY.md"), REGISTRY);
  const noConflictCli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-registry-archive.ts")],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: conflictRoot } });
  assert(noConflictCli.status === 0 && noConflictCli.stdout.split("\n").at(-2) === "  verify: live REMOVED count after run == 0 ✅",
    "zero-conflict CLI prints the byte-identical base verification line");
  fs.writeFileSync(path.join(conflictRoot, "memory/MEM_REGISTRY.md"), datedRow + "\n" + otherRow + "\n");
  fs.writeFileSync(path.join(conflictRoot, "memory/MEM_REGISTRY_ARCHIVE.md"), datedRow.replace("original", "archived") + "\n");
  const cli = spawnSync(process.execPath, [...process.execArgv, path.resolve("skills/memory/scripts/mem-registry-archive.ts")],
    { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: conflictRoot } });
  assert(cli.stdout.split("\n").includes("  verify: live REMOVED count after run == 1 retained conflicting row(s) ✅"),
    "CLI prints retained-conflict verification wording");
  assert(cli.status === 0, `archive CLI succeeds while retaining conflict: ${cli.stderr}`);
  const diagnostic = `duplicate MEM id ${DATED_A}: live row differs from archived row (not archived)`;
  assert(cli.stdout.split("\n").filter((line) => line === diagnostic).length === 1, "CLI prints exactly one required conflict diagnostic");
  assert(fs.readFileSync(path.join(conflictRoot, "memory/MEM_REGISTRY.md"), "utf8").includes(datedRow), "CLI preserves conflicting live content");
} finally {
  fs.rmSync(conflictRoot, { recursive: true, force: true });
}

console.log(`${passed} assertions passed, ${failed} failed`);
if (failed) process.exitCode = 1;
