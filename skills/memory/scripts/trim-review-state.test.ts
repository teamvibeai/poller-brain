#!/usr/bin/env npx tsx
/** End-to-end rejected-review fixtures, including real completed Git cycles. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { completedRejections, collectTrimDestinations, reviewItems, recordRejection,
  REVIEW_STATE_PATH, REVIEW_POLICY_VERSION } from "./lib/trim-review-state.js";
import { findLearningsTrimCandidates } from "./lib/mem-learnings-trim-core.js";
import { findTrimCandidates } from "./lib/mem-registry-trim-core.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trim-review-530-"));
const repo = process.cwd();
const env = { ...process.env, BRAIN_ROOT: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "test@example.test" };
let checks = 0;
function check(value: unknown, message: string): void { assert.ok(value, message); checks++; }
function write(file: string, text: string): void { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
function read(file: string): string { return fs.readFileSync(path.join(root, file), "utf8"); }
function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trimEnd();
}
function cli(kind: string, ...args: string[]) {
  return spawnSync(process.execPath, [...process.execArgv, path.join(repo, `skills/memory/scripts/mem-${kind}-trim.ts`), ...args], { cwd: root, env, encoding: "utf8" });
}
function proposal(kind: string, ...args: string[]): string {
  const result = cli(kind, ...args); assert.equal(result.status, 0, result.stderr); return result.stdout;
}
const refs = (output: string): string[] => [...output.matchAll(/^review-ref \S+: ([a-f0-9]{64})$/gm)].map(m => m[1]);
const cached = (kind: string, n: number, ...args: string[]): string => {
  const output = proposal(kind, ...args);
  check(output.includes(`previously rejected, unchanged: ${n}`), `${kind}: expected ${n} hits: ${output}`);
  return output;
};
function checkpoint(date: string, boundary: string): void {
  const result = spawnSync("bash", [path.join(repo, "scripts/consolidation-commit.sh"), root, date, boundary], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
// The checkpoint requires the durable marker and this cycle's history append (#516).
const startedCycles = new Map<string, string>();
function startCycle(date: string): string {
  const known = startedCycles.get(date);
  if (known) return known;
  const marker = spawnSync("bash", [path.join(repo, "scripts/consolidation-marker.sh"), "start", root, date], { cwd: root, env, encoding: "utf8" });
  assert.equal(marker.status, 0, marker.stdout + marker.stderr);
  const head = git("rev-parse", "HEAD");
  startedCycles.set(date, head);
  openCycle = date;
  return head;
}
let openCycle: string | undefined;
// Keep fixture reports away from today's UTC date: the state checker also
// inspects today's report and would compare an older cycle to the active marker.
const cycleYear = new Date().getUTCFullYear() - 1;
const firstCycleDate = `${cycleYear}-11-01`;
let cycle = 0;
function nextDate(): string {
  let date: string;
  do date = `${cycleYear}-11-${String(++cycle).padStart(2, "0")}`; while (startedCycles.has(date));
  return date;
}
function complete(consume = false): string {
  // Finish an already-started cycle (as production does) before starting a new one.
  const date = openCycle ?? nextDate();
  const startingHead = startCycle(date);
  const history = path.join(root, `memory/episodic/archive/consolidation-history-${cycleYear}-H2.md`);
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.appendFileSync(history, `\n## Consolidation ${date} / ${startingHead}\nStatus: in progress\nWork performed: Reviewed trim proposals; zero promotions.\n<!-- /consolidation-history -->\n`);
  write(`reports/${date}-memory-consolidation.md`, "# Completed fixture\n");
  write(`reports/${date}-memory-consolidation.json`, JSON.stringify({ operationType: "consolidation", consolidationHistory: { version: 1, cycleDate: date, startingHead } }) + "\n");
  checkpoint(date, "steps 10-12");
  if (consume) {
    fs.unlinkSync(path.join(root, `reports/${date}-memory-consolidation.json`));
    git("add", "-u"); git("commit", "-qm", "consume report JSON");
  }
  checkpoint(date, "final");
  const cleared = spawnSync("bash", [path.join(repo, "scripts/consolidation-marker.sh"), "clear", root, date], { cwd: root, env, encoding: "utf8" });
  assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
  openCycle = undefined;
  return git("rev-parse", "HEAD");
}
const key = "MEM-2026-11-01-120000-550e8400-e29b-41d4-a716-446655440000";
const registryKey = key.replace("120000", "130000");
const learning = "memory/core/LEARNINGS.md";
const registry = "memory/MEM_REGISTRY.md";
const body = "Record the deployment SHA and rollback command before releasing. ".repeat(5).trim();
const source = `- **Preserve deployment evidence** — ${body} [MEM-124]\n\n- **Dated lesson** — ${body} [${key}]\n`;
const rows = `| Key | Status | Created | Description |\n|---|---|---|---|\n| MEM-125 | ACTIVE | 2026-09-01 | ${body} |\n| ${registryKey} | ACTIVE | 2026-11-01 | ${body} |\n`;
const dest = `### Deployment safety policy [MEM-124]\n[MEM-124] ${body}\n### Deployment safety policy [${key}]\n[${key}] ${body}\n### Deployment safety policy [MEM-125]\n[MEM-125] ${body}\n### Deployment safety policy [${registryKey}]\n[${registryKey}] ${body}\n`;
const destination = "memory/semantic/deployment.md";
try {
  write("CLAUDE.md", "Fixture\n"); write(learning, source); write(registry, rows); write(destination, dest);
  git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
  const initial: Record<string, string[]> = {};
  for (const kind of ["learnings", "registry"]) {
    initial[kind] = refs(cached(kind, 0));
    check(initial[kind].length === 2, `${kind}: legacy and full dated IDs proposed`);
    const bytes = read(kind === "learnings" ? learning : registry);
    for (const ref of initial[kind]) {
      const record = cli(kind, "--reject", ref, "--reason", "Incidental bookkeeping; retain original lesson");
      check(record.status === 0 && record.stdout.includes("pending completed consolidation"), `${kind}: rejection recorded: ${record.stderr}`);
    }
    check(read(kind === "learnings" ? learning : registry) === bytes, `${kind}: rejection never trims source`);
    check(refs(cached(kind, 0)).length === 2, `${kind}: pending state never suppresses review`);
  }
  startCycle(firstCycleDate);
  checkpoint(firstCycleDate, "steps 8-9");
  check(git("show", `HEAD:${REVIEW_STATE_PATH}`) === read(REVIEW_STATE_PATH).trimEnd(), "normal memory checkpoint persists the exact ledger");
  for (const kind of ["learnings", "registry"]) cached(kind, 0);
  let completedAt = complete(true);
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const kind of ["learnings", "registry"]) {
      const output = cached(kind, 2);
      check(refs(output).length === 0 && !output.includes("review, then apply"), `${kind}: unchanged rejection reviewed once`);
      check(output.includes("Incidental bookkeeping") && output.includes(REVIEW_STATE_PATH + "#"), `${kind}: reason reference emitted`);
    }
    complete();
  }
  fs.unlinkSync(path.join(root, registry));
  complete();
  cached("learnings", 2);
  write(registry, rows);
  complete();
  cached("learnings", 2);
  cached("registry", 0);
  for (const ref of initial.registry) {
    check(cli("registry", "--reject", ref, "--reason", "Re-reviewed restored registry owner").status === 0, "restored source requires fresh review");
  }
  completedAt = complete();
  cached("registry", 2);
  for (const kind of ["learnings", "registry"]) {
    check(refs(cached(kind, 0, "--reconsider")).length === 2, `${kind}: explicit reconsideration reopens review`);
    const failed = cli(kind, "--apply", "--reject", initial[kind][0], "--reason", "bad", "--only", "MEM-124");
    check(failed.status !== 0, `${kind}: cache cannot authorize apply`);
    check(cli(kind, "--apply").status !== 0, `${kind}: apply still requires explicit approval`);
  }
  for (const [kind, file, approvedKey] of [["learnings", learning, "MEM-124"], ["registry", registry, "MEM-125"]]) {
    const before = read(file);
    const ledgerBefore = read(REVIEW_STATE_PATH);
    const applied = cli(kind, "--apply", "--only", approvedKey);
    check(applied.status === 0 && read(file) !== before, `${kind}: explicit fresh approval still applies despite old rejection`);
    check(read(REVIEW_STATE_PATH) === ledgerBefore, `${kind}: apply neither reads approval from nor writes approval into ledger`);
    write(file, before);
  }
  write("CLAUDE.md", "fixture\n");
  for (const kind of ["learnings", "registry"]) cached(kind, 0);
  write("CLAUDE.md", "Fixture\n");
  write("MAINTENANCE.md", "New local review policy\n");
  for (const kind of ["learnings", "registry"]) cached(kind, 0);
  fs.unlinkSync(path.join(root, "MAINTENANCE.md"));
  // Harmless source line shifts retain content identity and current navigation.
  write(learning, "\n\n" + source);
  complete();
  cached("learnings", 2);
  write(learning, source); write(registry, "\n\n" + rows);
  complete();
  cached("registry", 2);
  write(learning, source.replace("deployment SHA", "deployment sha"));
  write(registry, rows.replace("2026-09-01", "2026-09-02"));
  check(Buffer.byteLength(read(learning)) === Buffer.byteLength(source), "same-size source edit fixture");
  cached("learnings", 1);
  check(cli("learnings", "--reject", initial.learnings[0], "--reason", "stale").status !== 0, "stale fingerprint cannot record changed review");
  write(learning, source);
  cached("registry", 1);

  write(learning, source); write(registry, rows);
  for (const changed of [dest.replace("safety policy", "safety review"), dest + "New governing context.\n"]) {
    write(destination, changed);
    for (const kind of ["learnings", "registry"]) cached(kind, 0);
  }
  write(destination, dest);
  write("memory/semantic/zzz-new.md", "### New alternate evidence [MEM-124]\nAdditional narrative [MEM-124]\n");
  for (const kind of ["learnings", "registry"]) cached(kind, 0);
  fs.unlinkSync(path.join(root, "memory/semantic/zzz-new.md"));
  fs.renameSync(path.join(root, destination), path.join(root, "memory/semantic/renamed.md"));
  for (const kind of ["learnings", "registry"]) cached(kind, 0);
  fs.renameSync(path.join(root, "memory/semantic/renamed.md"), path.join(root, destination));
  fs.unlinkSync(path.join(root, destination));
  for (const kind of ["learnings", "registry"]) {
    check(refs(cached(kind, 0)).length === 0, `${kind}: missing destination never uses cache`);
    check(cli(kind, "--reject", initial[kind][0], "--reason", "unavailable").status !== 0, `${kind}: missing evidence cannot be recorded`);
  }
  write(destination, dest);
  const destinations = collectTrimDestinations(root, ["semantic", "episodic", "procedural"]);
  const candidates = findLearningsTrimCandidates(source, destinations).candidates;
  const items = reviewItems(root, learning, source, candidates, destinations);
  const policyChanged = reviewItems(root, learning, source, candidates, destinations, REVIEW_POLICY_VERSION + "-next");
  check(items.every((i, n) => i.id !== policyChanged[n].id), "policy version invalidates every decision");
  const policyRecords = completedRejections(root).records;
  check(policyRecords.length > 0 && policyChanged.every(i => !policyRecords.some(r => r.id === i.id)), "changed policy has no reusable completed verdict");
  write(`memory/episodic/consolidation-progress-${firstCycleDate}.md`, "### Bookkeeping\nUnrelated review tally [MEM-124]\n");
  check(JSON.stringify(collectTrimDestinations(root, ["semantic", "episodic", "procedural"])) === JSON.stringify(destinations), "progress bookkeeping excluded from inventory and evidence");
  cached("learnings", 2);

  // Different spans sharing a key retain independent decisions and selectors.
  const other = `- **Another unrelated lesson** — Keep the complete narrative [MEM-124]\n`;
  write(learning, source + "\n" + other);
  const onePending = cached("learnings", 2);
  check(refs(onePending).length === 1 && /MEM-124@\d+ \(LEARNINGS/.test(onePending), "different same-key span never inherits rejection; selectors retained");
  check(cli("learnings", "--apply", "--only", "MEM-124").status !== 0, "cached filtering never weakens apply ambiguity guard");
  write(learning, source + "\n" + source.split("\n")[0] + "\n");
  const duplicate = cached("learnings", 1);
  const dupRefs = refs(duplicate);
  check(dupRefs.length === 2 && dupRefs[0] !== dupRefs[1], "identical duplicate spans require distinct reviews");
  check(cli("learnings", "--reject", dupRefs[0], "--reason", "duplicate explicit rejection").status === 0, "ambiguous rejection can be recorded for audit");
  complete();
  check(refs(cached("learnings", 1)).length === 2, "ambiguous spans never suppress review even after completion");
  write(learning, source);
  cached("learnings", 1);
  complete();
  cached("learnings", 1);
  check(cli("learnings", "--reject", initial.learnings[0], "--reason", "Re-reviewed unique owner after duplicate removal").status === 0,
    "unique span can receive a fresh explicit rejection after ambiguous history");
  completedAt = complete();
  cached("learnings", 2);
  write(registry, rows + rows.split("\n")[2] + "\n");
  const dupRegistry = cached("registry", 1);
  check(dupRegistry.includes('duplicateKeys: ["MEM-125"]'), "registry duplicate guard unchanged");
  write(registry, rows);

  fs.writeFileSync(path.join(root, destination), Buffer.concat([Buffer.from(dest), Buffer.from([0xff])]));
  for (const kind of ["learnings", "registry"]) {
    const output = cached(kind, 0);
    check(output.includes("review, then apply") && refs(output).length === 0, `${kind}: uncertain encoding restores review and disables recording`);
  }
  write(destination, dest);
  const valid = read(REVIEW_STATE_PATH);
  for (const broken of ["{", JSON.stringify({ version: 2, rejections: [] }), valid.replace('"rejected"', '"approved"'), valid.replace('"entryDigest": "', '"entryDigest": "bad')]) {
    write(REVIEW_STATE_PATH, broken);
    for (const kind of ["learnings", "registry"]) cached(kind, 0);
  }
  write(REVIEW_STATE_PATH, valid);
  fs.unlinkSync(path.join(root, REVIEW_STATE_PATH));
  for (const kind of ["learnings", "registry"]) cached(kind, 0);
  write(REVIEW_STATE_PATH, valid);
  write(REVIEW_STATE_PATH + ".lock", "interrupted writer");
  for (const kind of ["learnings", "registry"]) cached(kind, 0);
  check(cli("registry", "--reject", initial.registry[0], "--reason", "locked").status !== 0, "interrupted writer lock is never stolen");
  fs.unlinkSync(path.join(root, REVIEW_STATE_PATH + ".lock"));
  // The exact state destination cannot redirect a write outside the brain.
  fs.unlinkSync(path.join(root, REVIEW_STATE_PATH)); write("outside.json", valid);
  fs.symlinkSync(path.join(root, "outside.json"), path.join(root, REVIEW_STATE_PATH));
  cached("learnings", 0);
  check(cli("learnings", "--reject", initial.learnings[0], "--reason", "unsafe").status !== 0, "symlink state path rejected");
  check(read("outside.json") === valid, "unsafe state write preserves external target");
  fs.unlinkSync(path.join(root, REVIEW_STATE_PATH)); write(REVIEW_STATE_PATH, valid);
  fs.linkSync(path.join(root, "outside.json"), path.join(root, "memory/hardlink.json"));
  fs.unlinkSync(path.join(root, REVIEW_STATE_PATH)); fs.renameSync(path.join(root, "memory/hardlink.json"), path.join(root, REVIEW_STATE_PATH));
  cached("registry", 0);
  check(cli("registry", "--reject", initial.registry[0], "--reason", "unsafe").status !== 0, "hardlink state path rejected");
  fs.unlinkSync(path.join(root, REVIEW_STATE_PATH)); write(REVIEW_STATE_PATH, valid);
  fs.renameSync(path.join(root, "memory"), path.join(root, "memory-safe"));
  fs.symlinkSync(path.join(root, "memory-safe"), path.join(root, "memory"));
  cached("learnings", 0);
  check(cli("learnings", "--reject", initial.learnings[0], "--reason", "unsafe parent").status !== 0, "symlink parent rejected");
  fs.unlinkSync(path.join(root, "memory")); fs.renameSync(path.join(root, "memory-safe"), path.join(root, "memory"));

  // Active checkpoints fail open by default; the uninterrupted invocation may
  // explicitly use its already-recorded pre-Step-0 HEAD (same as #466).
  const pending = nextDate();
  startCycle(pending);
  git("add", "."); git("commit", "-qm", `chore: consolidate memory checkpoint (${pending}) — step 0`);
  cached("learnings", 0);
  cached("learnings", 2, "--completed-at", completedAt);
  cached("learnings", 0, "--completed-at", "not-a-commit");
  check(completedRejections(root).records.length === 0, "unfinished completion never resurrects older reviews");

  write(REVIEW_STATE_PATH, "{broken");
  complete();
  write(REVIEW_STATE_PATH, valid);
  cached("learnings", 0);
  fs.unlinkSync(path.join(root, REVIEW_STATE_PATH));
  complete();
  write(REVIEW_STATE_PATH, valid);
  cached("learnings", 0);
  const reportless = nextDate();
  git("add", "."); git("commit", "-qm", `chore: consolidate memory (${reportless})`);
  cached("learnings", 0);

  // Original #530 incidental citation is reviewable but #505 still rejects it
  // for registry trimming. Existing index/multi-key shapes remain ineligible.
  const incidental = [{ file: "episodic/cycle.md", text: "### Consolidation bookkeeping [MEM-124]\nReviewed the deployment checklist per [MEM-124]; no trim approved.\n" }];
  check(findLearningsTrimCandidates(source, incidental).candidates.length === 1, "original incidental proposal still requires explicit review");
  const guarded = findTrimCandidates(rows.replace("MEM-125", "MEM-124"), incidental);
  check(guarded.candidates.length === 0 && guarded.contentCoverage[0].missingTokens[0] === "no-literal-match", "#505 literal-match rejection unchanged");
  check(findLearningsTrimCandidates(source.replace("[MEM-124]", "[MEM-124][MEM-607]"), incidental).candidates.length === 0, "multi-key false-positive stays rejected");
  check(findLearningsTrimCandidates(source, [{ file: "semantic/index.md", text: "### Index heading\n- [MEM-124] → see semantic/other.md — lookup\n" }]).candidates.length === 0, "index pointer false-positive stays rejected");

  // The last span/row must keep its CR or Markdown hard-break spaces when
  // historical ownership is checked, just as reviewItems hashes them today.
  for (const [ending, suffix, changedSuffix] of [["CRLF", "\r\n", "\n"], ["trailing spaces", "  \n", " \n"], ["LF", "\n", " \n"]]) {
    const byteSources = [
      ["learnings", learning, `- **Preserve deployment evidence** — ${body} [MEM-124]${suffix}`],
      ["registry", registry, `| Key | Status | Created | Description |${suffix}|---|---|---|---|${suffix}| MEM-125 | ACTIVE | 2026-09-01 | ${body} |${suffix}`],
    ];
    write(REVIEW_STATE_PATH, JSON.stringify({ version: 1, rejections: [] }));
    for (const [kind, file, text] of byteSources) {
      write(file, text);
      const proposed = refs(cached(kind, 0));
      check(proposed.length === 1, `${kind} ${ending}: final item is reviewable`);
      check(cli(kind, "--reject", proposed[0], "--reason", "Retain exact source bytes").status === 0,
        `${kind} ${ending}: rejection recorded`);
    }
    complete();
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const [kind, file, text] of byteSources) {
        check(fs.readFileSync(path.join(root, file)).equals(Buffer.from(text)), `${kind} ${ending}: source bytes unchanged`);
        check(refs(cached(kind, 1)).length === 0, `${kind} ${ending}: completed unchanged rejection stays a hit`);
      }
      if (repeat === 0) complete();
    }
    for (const [kind, file, text] of byteSources) {
      // Change only the final item's whitespace, preserving its trim candidacy.
      write(file, text.slice(0, -suffix.length) + changedSuffix);
      check(refs(cached(kind, 0)).length === 1, `${kind} ${ending}: changed source bytes require review`);
    }
    complete();
    for (const [kind, file, text] of byteSources) write(file, text);
    complete();
    for (const [kind] of byteSources) {
      check(refs(cached(kind, 0)).length === 1, `${kind} ${ending}: committed byte change breaks continuous ownership after restore`);
    }
    console.log(`${ending}: learnings + registry unchanged hits, byte-change misses, restored-history misses`);
  }
  console.log(`${checks} review-ledger checks passed, 0 failed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
