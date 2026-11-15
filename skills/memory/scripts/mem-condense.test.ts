#!/usr/bin/env npx tsx
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { buildCondensation, selectTopic, measure, sources, type Mode } from "./lib/mem-condense-core.js";
import { collectTrimDestinations, reviewItems, recordRejection } from "./lib/trim-review-state.js";
import { findLearningsTrimCandidates } from "./lib/mem-learnings-trim-core.js";
import { completedZeroCycles } from "./lib/trim-exhaustion.js";
import { findTrimCandidates, parseRegistryCells } from "./lib/mem-registry-trim-core.js";
import "./mem-condense-regression.test.js";
const repo = process.cwd();
const base = fs.mkdtempSync(path.join(os.tmpdir(), "condensation-530-"));
let checks = 0;
const check = (v: unknown, why: string) => { assert.ok(v, why); checks++; };
const rule = "Record the release SHA before deployment; skip only for a documented sandbox.";
const body = "Record the release SHA and rollback command before deployment. Skip only for a documented sandbox; retain approval provenance and exception conditions. ".repeat(4).trim();
const dated = "MEM-2026-11-01-120000-550e8400-e29b-41d4-a716-446655440000";
const keys = [dated, ...Array.from({ length: 19 }, (_, i) => `MEM-${i + 2}`)];
const learnings = "# Rules\n\n" + keys.map(k => `- **Release safety** — ${body} (Source: release review, [${k}])\n`).join("\n");
const registry = "# Registry\n| Key | Status | Created | Obsoleted | Description |\n|---|---|---|---|---|\n" + keys.map(k => `| ${k} | ACTIVE | 2026-09-01 | - | ${body} |\n`).join("");
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };
function fixture(name: string, mode: Mode, text: string) {
  const root = path.join(base, name); fs.mkdirSync(path.join(root, "memory/core"), { recursive: true });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture\n"); fs.writeFileSync(path.join(root, sources[mode]), text);
  const git = (...a: string[]) => { const r = spawnSync("git", a, { cwd: root, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trimEnd(); };
  git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
  const cli = (...a: string[]) => spawnSync(process.execPath, [...process.execArgv, path.join(repo, "skills/memory/scripts/mem-condense.ts"), ...a], { cwd: repo, env: { ...env, BRAIN_ROOT: root }, encoding: "utf8" });
  const snapshot = () => ({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), text: fs.readFileSync(path.join(root, sources[mode]), "utf8") });
  return { root, git, cli, snapshot };
}
try {
  for (const [mode, text] of [["learnings", learnings], ["registry", registry]] as [Mode, string][]) {
    const topic = selectTopic(mode, text, { rule, destination: "procedural/release-safety.md" }).topic!;
    const result = buildCondensation(mode, text, topic, { destination: "procedural/release-safety.md", rule });
    console.log(`${mode} ACTIVE fixture: hot bytes ${result.before.sizeBytes} -> ${result.afterMetrics.sizeBytes}; threshold ${result.before.threshold} -> ${result.afterMetrics.threshold}; overage ${result.before.overage} -> ${result.afterMetrics.overage}; corpus bytes ${Buffer.byteLength(text)} -> ${Buffer.byteLength(result.after) + Buffer.byteLength(result.destinationText)}`);
    check(result.afterMetrics.sizeBytes < result.before.sizeBytes && result.afterMetrics.overage < result.before.overage, `${mode}: strict byte and scaled overage reduction`);
    check(result.afterMetrics.entryCount === result.before.entryCount, `${mode}: entry count preserved`);
    check(result.destinationText.includes(topic.original), `${mode}: full original narrative and provenance preserved`);
    for (const key of keys) check(result.after.includes(key), `${mode}: ${key} stays discoverable`);
    check(result.after.includes(rule) && result.destinationText.split("\n")[2].includes(topic.key), `${mode}: rule, exceptions and line-qualified target valid`);
    if (mode === "registry") {
      check(result.destinationText.split("\n").includes(topic.description!), "complete Description on matching line");
      check(findTrimCandidates(text, [{ file: "procedural/release-safety.md", text: result.destinationText }]).contentCoverage[0].status === "covered", "#505 rerun passes");
      const oldRows = text.split("\n").map(parseRegistryCells).filter(Boolean), newRows = result.after.split("\n").map(parseRegistryCells).filter(Boolean);
      check(oldRows.every((row, i) => [1, 2, 3].every(cell => row![cell] === newRows[i]![cell])), "every Key/Status/Created cell identical");
    }
    const f = fixture(mode, mode, text), initial = f.snapshot();
    const scratch = path.join(base, mode + "-proposal");
    const proposed = f.cli("--mode", mode, "--scratch", scratch, "--rule", rule);
    assert.equal(proposed.status, 0, proposed.stdout + proposed.stderr);
    check(proposed.stdout.includes("heuristic exhausted — condensation review needed") && proposed.stdout.includes("consecutive zero-progress cycles=1"), "explicit exhausted outcome");
    assert.deepEqual(f.snapshot(), initial); checks++;
    const planFile = path.join(scratch, "plan.json"), planText = fs.readFileSync(planFile, "utf8"), plan = JSON.parse(planText);
    check(plan.metrics.corpusAfter >= plan.metrics.corpusBefore, "corpus growth reported separately from hot-path shrink");
    const approved = ["--apply", "--plan", planFile, "--only", `${topic.key}@${topic.start}`, "--cycle-date", "2026-11-15"];
    const missingApproval = f.cli("--apply", "--plan", planFile, "--cycle-date", "2026-11-15");
    check(missingApproval.status !== 0, "explicit selector required"); assert.deepEqual(f.snapshot(), initial);
    fs.writeFileSync(path.join(f.root, ".git/consolidation-start"), `v1 2026-11-15 ${initial.head}\n`);
    fs.writeFileSync(planFile, JSON.stringify({ ...plan, rule: "Silently omit all exception conditions." }));
    check(f.cli(...approved).status !== 0, "altered proposal rejected"); assert.deepEqual(f.snapshot(), initial);
    fs.writeFileSync(planFile, planText);
    fs.writeFileSync(path.join(f.root, sources[mode]), text.replace("rollback", "rollbaCK"));
    const edited = f.snapshot();
    check(f.cli(...approved).status !== 0, "same-size source change invalidates proposal"); assert.deepEqual(f.snapshot(), edited);
    fs.writeFileSync(path.join(f.root, sources[mode]), text);
    const destinationFile = path.join(f.root, "memory", plan.destination);
    fs.mkdirSync(path.dirname(destinationFile), { recursive: true }); fs.writeFileSync(destinationFile, "Existing content must survive.\n");
    const existing = f.snapshot();
    check(f.cli(...approved).status !== 0, "existing destination refuses overwrite"); assert.deepEqual(f.snapshot(), existing);
    check(fs.readFileSync(destinationFile, "utf8") === "Existing content must survive.\n", "existing destination bytes retained");
    fs.unlinkSync(destinationFile);

    const sourcePreview = path.join(scratch, "source.md");
    fs.writeFileSync(sourcePreview, "Unreviewed preview change\n");
    check(f.cli(...approved).status !== 0, "preview/plan disagreement rejected"); assert.deepEqual(f.snapshot(), initial);
    fs.writeFileSync(sourcePreview, plan.sourceAfter);
    // A synchronous transaction failure must restore BOTH files and HEAD.
    env.GIT_AUTHOR_NAME = "";
    check(f.cli(...approved).status !== 0, "transaction failure rejected"); assert.deepEqual(f.snapshot(), initial);
    check(!fs.existsSync(path.join(f.root, "memory", plan.destination)), "failed transaction leaves no destination");
    env.GIT_AUTHOR_NAME = "Test";
    const applied = f.cli(...approved);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    check(fs.readFileSync(path.join(f.root, sources[mode]), "utf8") === plan.sourceAfter, "applied reviewed hot bytes");
    check(fs.readFileSync(path.join(f.root, "memory", plan.destination), "utf8") === plan.destinationText, "applied complete destination bytes");
    check(applied.stdout.includes("Still over cap"), "remaining warning retained");
    const secondScratch = path.join(base, mode + "-second");
    const second = f.cli("--mode", mode, "--scratch", secondScratch, "--rule", rule);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    check(second.stdout.includes("budget already used") && !fs.existsSync(path.join(secondScratch, "plan.json")), "one proposal after accepted relocation per cycle");
    const afterOne = f.snapshot();
    check(f.cli(...approved).status !== 0, "old plan cannot apply again");
    assert.deepEqual(f.snapshot(), afterOne);
  }
  const heading = "# Rules\r\n\r\n### Release safety\r\n\r\n" + body.repeat(10) + "\r\n(Source: release review, [MEM-1])\r\n\r\n";
  const headingPlan = buildCondensation("learnings", heading, selectTopic("learnings", heading, { rule }).topic!, { destination: "episodic/release.md", rule });
  check(headingPlan.after.includes("### [MEM-1] → see episodic/release.md:3"), "heading pointer preserves its level and resolves line 3");
  check(headingPlan.destinationText.includes(selectTopic("learnings", heading, { rule }).topic!.original), "CRLF original narrative preserved");
  const grouped = "# Rules\n\n- Keep both [MEM-1] and [MEM-2] together. " + body.repeat(10) + "\n";
  check(selectTopic("learnings", grouped, { rule }).topic === null && selectTopic("learnings", grouped, { rule }).refusals.some(r => r.includes("multi-key")), "grouped entry refused and reported");
  const linked = learnings.replaceAll("release review", "see semantic/other.md");
  check(selectTopic("learnings", linked, { rule }).topic === null, "linked narrative refused, preventing self/circular references");
  for (const destination of ["core/LEARNINGS.md", "../escape.md", "semantic/../bad.md", "episodic/archive/log.md", "episodic/consolidation-progress-2026-11-15.md"]) {
    assert.throws(() => buildCondensation("learnings", learnings, selectTopic("learnings", learnings, { rule }).topic!, { destination, rule })); checks++;
  }
  const tiny = "# Rules\n" + "preamble ".repeat(700) + "\n\n- Short rule [MEM-1]\n";
  const f = fixture("no-shrink", "learnings", tiny), before = f.snapshot();
  const noShrink = f.cli("--mode", "learnings", "--scratch", path.join(base, "no-shrink-plan"), "--rule", rule);
  check(noShrink.status === 0 && noShrink.stdout.includes("Keep the over-cap warning"), "no-shrink refuses with warning"); assert.deepEqual(f.snapshot(), before);
  check(!fs.existsSync(path.join(base, "no-shrink-plan")), "unsafe proposal writes no scratch plan");
  const duplicate = registry + registry.split("\n").find(l => l.startsWith("| MEM-2 |")) + "\n";
  check(selectTopic("registry", duplicate, { rule }).refusals.some(r => r.includes("duplicate key")), "duplicate rows refused");
  const malformed = "| MEM-1 | ACTIVE | now | " + body + " | extra | too | many |\n";
  check(selectTopic("registry", malformed, { rule }).topic === null, "malformed table refused");
  // Original false-positive coverage contract remains fail closed.
  const row = `| MEM-1 | ACTIVE | now | ${body} |\n`;
  for (const destination of [`# Release safety\nIncidental comparison [MEM-1]: unrelated.\n`, `# Release safety\n[MEM-1] ${body.slice(0, 100)}\n`]) {
    const found = findTrimCandidates(row, [{ file: "semantic/false.md", text: destination }]);
    check(found.candidates.length === 0 && found.contentCoverage[0].missingTokens[0] === "no-literal-match", "#505 false positive rejected");
  }
  // A completed slice-1 rejection contributes counts, never apply approval.
  const cached = fixture("cached", "learnings", learnings);
  fs.mkdirSync(path.join(cached.root, "memory/semantic"));
  fs.writeFileSync(path.join(cached.root, "memory/semantic/incidental.md"), "# Release safety comparison\nIncidental comparison with [MEM-2]; unrelated policy.\n");
  const destinations = collectTrimDestinations(cached.root, ["semantic", "episodic", "procedural"]);
  const candidates = findLearningsTrimCandidates(learnings, destinations).candidates;
  check(candidates.length === 1, "incidental citation remains human-review evidence only");
  recordRejection(cached.root, reviewItems(cached.root, sources.learnings, learnings, candidates, destinations)[0], "Incidental citation does not preserve the lesson");
  fs.mkdirSync(path.join(cached.root, "reports"));
  fs.writeFileSync(path.join(cached.root, "reports/2026-11-01-memory-consolidation.md"), "# Completed review\n");
  fs.writeFileSync(path.join(cached.root, "reports/2026-11-01-memory-consolidation.json"), "{}\n");
  cached.git("add", "."); cached.git("commit", "-qm", "chore: consolidate memory (2026-11-01)");
  const cachedStatus = cached.cli("--mode", "learnings", "--status");
  assert.equal(cachedStatus.status, 0, cachedStatus.stderr);
  check(cachedStatus.stdout.includes("unchanged-verdicts=1"), "exhaustion uses valid completed slice-1 unchanged-verdict count");
  const progressStatus = cached.cli("--mode", "learnings", "--status", "--before-bytes", String(Buffer.byteLength(learnings) + 100));
  check(progressStatus.stdout.includes("consecutive zero-progress cycles=0"), "actual reduction resets zero-progress cycles");
  const cacheApply = cached.cli("--apply", "--completed-at", cached.git("rev-parse", "HEAD"));
  check(cacheApply.status !== 0, "completed review cache cannot authorize apply");
  // Completed report history counts cycles once; drafts/checkpoints cannot inflate it.
  const history = fixture("history", "learnings", learnings);
  const metrics = measure("learnings", learnings);
  const reportRecord = { version: 1, source: sources.learnings, outcome: "heuristic exhausted — condensation review needed", beforeBytes: metrics.sizeBytes, afterBytes: metrics.sizeBytes, threshold: metrics.threshold };
  fs.mkdirSync(path.join(history.root, "reports"));
  for (let i = 1; i <= 2; i++) {
    const date = `2026-11-0${i}`;
    fs.writeFileSync(path.join(history.root, `reports/${date}-memory-consolidation.md`), `# Report\ntrim-outcome: ${JSON.stringify(reportRecord)}\n`);
    fs.writeFileSync(path.join(history.root, `reports/${date}-memory-consolidation.json`), "{}\n");
    history.git("add", "."); history.git("commit", "-qm", `chore: consolidate memory (${date})`);
    check(completedZeroCycles(history.root, "learnings") === i, "count completed zero progress cycles");
  }
  const final = history.git("rev-parse", "HEAD");
  history.git("commit", "--allow-empty", "-qm", "chore: consolidate memory checkpoint (2026-11-03) — step 5d");
  check(completedZeroCycles(history.root, "learnings") === 0, "unfinished checkpoint history not reused");
  check(completedZeroCycles(history.root, "learnings", final) === 2, "original starting HEAD supplies valid completed history");
  history.git("commit", "--allow-empty", "-qm", "chore: consolidate memory (2026-11-03)");
  check(completedZeroCycles(history.root, "learnings") === 0, "missing report pair fails open");
  console.log(`mem-condense: ${checks} assertions passed`);
} finally { fs.rmSync(base, { recursive: true, force: true }); }
