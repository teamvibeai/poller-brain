/** #530 slice2: reference dependencies and an unshrinkable shortest entry. */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildCondensation, measure, selectTopic, sources, type Mode } from "./lib/mem-condense-core.js";

const rule = "Record the release SHA before deployment; skip only for a documented sandbox.";
const long = "Record the release SHA and rollback command before deployment. Retain approval provenance and exception conditions. ".repeat(55).trim();
const entry = (mode: Mode, key: string, body: string) => mode === "learnings" ?
  `- ${body} [${key}]` : `| ${key} | ACTIVE | 2026-09-01 | ${body} |`;
const repo = process.cwd();

for (const mode of ["learnings", "registry"] as const) {
  for (const [style, link] of [["full", "[deployment policy][deploy]"], ["collapsed", "[deploy][]"],
    ["shortcut", "[deploy]"], ["folded label", "[policy][ Deploy   Policy ]"]]) {
    for (const position of ["preamble", "footer"]) {
      test(`${mode}: refuse ${style} reference with definition in ${position}`, () => {
        const definition = `[${style === "folded label" ? "deploy policy" : "deploy"}]: https://example.test/policy`;
        const topic = entry(mode, "MEM-1", `Follow ${link}. ${long}`);
        const text = position === "preamble" ? `# Rules\n\n${definition}\n\n${topic}\n` :
          `# Rules\n\n${topic}\n\n# Definitions\n\n${definition}\n`;
        const selected = selectTopic(mode, text, { rule });
        assert.equal(selected.topic, null);
        assert.ok(selected.refusals.some(r => r.includes("reference") && r.includes("MEM-1")));
        const start = text.split("\n").indexOf(topic) + 1;
        assert.throws(() => buildCondensation(mode, text, { key: "MEM-1", start, end: start, original: topic }, { rule }), /stale|bounded selection/);
      });
    }
  }
  test(`${mode}: a bare bracket without a definition remains eligible`, () => {
    const text = `# Rules\n\n${entry(mode, "MEM-1", `Keep [deployment policy] handy. ${long}`)}\n`;
    assert.equal(selectTopic(mode, text, { rule }).topic?.key, "MEM-1");
  });
  test(`${mode}: an unmatched bracket cannot hide an external definition`, () => {
    const text = `# Rules\n\nUnclosed [preamble bracket.\n\n[deploy]: https://example.test/policy\n\n${entry(mode, "MEM-1", `Follow [deploy]. ${long}`)}\n`;
    assert.equal(selectTopic(mode, text, { rule }).topic, null);
  });
  test(`${mode}: skip shortest unshrinkable entry deterministically`, () => {
    const short = entry(mode, "MEM-1", "Keep receipts");
    const big = entry(mode, "MEM-2", long);
    const text = `# Rules\n\n${short}\n\n${big}\n`;
    assert.ok(Buffer.byteLength(big) < 8192);
    assert.ok(measure(mode, text).overCap);
    const first = selectTopic(mode, text, { rule });
    assert.equal(first.topic?.key, "MEM-2");
    assert.ok(first.refusals.some(r => r.includes("MEM-1") && r.includes("shrink")));
    assert.deepEqual(selectTopic(mode, text, { rule }), first);
  });
  test(`${mode}: measure the actual rule and custom destination before choosing`, () => {
    const medium = entry(mode, "MEM-1", "Keep receipts. ".repeat(15).trim());
    const text = `# Rules\n\n${medium}\n\n${entry(mode, "MEM-2", long)}\n`;
    assert.equal(selectTopic(mode, text, { rule }).topic?.key, "MEM-1");
    const options = { rule: "Retain deployment evidence. ".repeat(8).trim(), destination: `procedural/${"long-path-".repeat(15)}release.md` };
    const topic = selectTopic(mode, text, options).topic!;
    assert.equal(topic.key, "MEM-2");
    const result = buildCondensation(mode, text, topic, options);
    assert.ok(result.after.includes(medium));
    assert.ok(result.afterMetrics.sizeBytes < result.before.sizeBytes);
  });
  test(`${mode}: ties use source order`, () => {
    const text = `# Rules\n\n${entry(mode, "MEM-3", long)}\n\n${entry(mode, "MEM-2", long)}\n`;
    assert.equal(selectTopic(mode, text, { rule }).topic?.key, "MEM-3");
  });

  for (const variant of ["default", "custom", "linked"]) {
    const linked = variant === "linked";
    test(`${mode}: CLI ${linked ? "refuses external reference without a plan" : `proposes and applies only the shrinkable topic (${variant} destination)`}`, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "condensation-regression-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const brain = path.join(root, "brain"), scratch = path.join(root, "proposal");
      const short = entry(mode, "MEM-1", "Keep receipts");
      // This intermediate dated-ID entry cannot shrink with its default path,
      // but would shrink with MEM-2's shorter path. Apply must reuse selection.
      const dated = entry(mode, "MEM-2026-11-01-120000-550e8400-e29b-41d4-a716-446655440000", "Keep receipts. ".repeat(10).trim());
      const text = linked ? `# Rules\n\n[deploy]: https://example.test/policy\n\n${entry(mode, "MEM-2", `Follow [deployment policy][deploy]. ${long}`)}\n` :
        `# Rules\n\n${short}\n\n${dated}\n\n${entry(mode, "MEM-2", long)}\n`;
      fs.mkdirSync(path.join(brain, "memory/core"), { recursive: true });
      fs.writeFileSync(path.join(brain, "CLAUDE.md"), "fixture\n");
      fs.writeFileSync(path.join(brain, sources[mode]), text);
      const env = { ...process.env, BRAIN_ROOT: brain, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: brain, env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trimEnd();
      };
      const cli = (...args: string[]) => spawnSync(process.execPath,
        [...process.execArgv, path.join(repo, "skills/memory/scripts/mem-condense.ts"), ...args], { cwd: repo, env, encoding: "utf8" });
      git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
      const head = git("rev-parse", "HEAD");
      const destination = variant === "custom" ? `procedural/${"long-".repeat(20)}release.md` : undefined;
      const proposal = cli("--mode", mode, "--scratch", scratch, "--rule", rule, ...(destination ? ["--destination", destination] : []));
      assert.equal(proposal.status, 0, proposal.stdout + proposal.stderr);
      assert.equal(fs.readFileSync(path.join(brain, sources[mode]), "utf8"), text);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("status", "--porcelain"), "");
      if (linked) {
        assert.match(proposal.stdout, /refused: MEM-2:.*reference/);
        assert.ok(!fs.existsSync(scratch));
        return;
      }
      const planFile = path.join(scratch, "plan.json");
      const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
      assert.equal(plan.topic.key, "MEM-2");
      assert.equal(plan.selectionDestination, destination ?? null);
      assert.equal(plan.sourceAfter.split("\n").filter((line: string) => line.includes("→ see") || line.includes("| see ")).length, 1);
      assert.ok(plan.sourceAfter.includes(short));
      assert.ok(plan.sourceAfter.includes(dated));
      assert.ok(plan.metrics.hotPathAfter.sizeBytes < plan.metrics.hotPathBefore.sizeBytes);
      fs.writeFileSync(path.join(brain, ".git/consolidation-start"), `v1 2026-11-15 ${head}\n`);
      const applied = cli("--apply", "--plan", planFile, "--only", `MEM-2@${plan.topic.start}`, "--cycle-date", "2026-11-15");
      assert.equal(applied.status, 0, applied.stdout + applied.stderr);
      assert.equal(fs.readFileSync(path.join(brain, sources[mode]), "utf8"), plan.sourceAfter);
      assert.equal(fs.readFileSync(path.join(brain, "memory", plan.destination), "utf8"), plan.destinationText);
      const secondScratch = path.join(root, "second-proposal");
      const second = cli("--mode", mode, "--scratch", secondScratch, "--rule", rule);
      assert.equal(second.status, 0, second.stdout + second.stderr);
      assert.match(second.stdout, /budget already used/);
      assert.ok(!fs.existsSync(secondScratch));
    });
  }
}

test("learnings: retained provenance counts toward pointer size", () => {
  const short = `- Keep receipts (Source: ${"review ".repeat(45).trim()}, [MEM-1])`;
  const text = `# Rules\n\n${short}\n\n${entry("learnings", "MEM-2", long)}\n`;
  assert.equal(selectTopic("learnings", text, { rule }).topic?.key, "MEM-2");
});

test("learnings: a definition already inside the whole topic stays verbatim", () => {
  const original = `## Deployment [MEM-1]\nFollow [policy][deploy]. ${long}\n\n[deploy]: https://example.test/policy`;
  const text = `# Rules\n\n${original}\n`;
  const topic = selectTopic("learnings", text, { rule }).topic!;
  assert.equal(topic.key, "MEM-1");
  const result = buildCondensation("learnings", text, topic, { rule });
  assert.ok(result.destinationText.includes(original));
  assert.ok(!result.after.includes("[deploy]:"));
});

test("registry: five-column pointer budgets both target occurrences", () => {
  const short = `| MEM-1 | ACTIVE | 2026-09-01 | - | ${"Keep receipts. ".repeat(9).trim()} |`;
  const text = `# Rules\n\n${short}\n\n${entry("registry", "MEM-2", long)}\n`;
  const topic = selectTopic("registry", text, { rule }).topic!;
  assert.equal(topic.key, "MEM-2");
  const result = buildCondensation("registry", text, topic, { rule });
  assert.ok(result.after.includes(short));
});

test("learnings: an equal-size pointer is refused before selection", () => {
  const destination = "semantic/equal.md";
  const pointerBytes = Buffer.byteLength(`- [MEM-1] → see ${destination}:3 — ${rule}`);
  const short = `- ${"x".repeat(pointerBytes - Buffer.byteLength("-  [MEM-1]"))} [MEM-1]`;
  assert.equal(Buffer.byteLength(short), pointerBytes);
  const selected = selectTopic("learnings", `# Rules\n\n${short}\n\n${entry("learnings", "MEM-2", long)}\n`, { rule, destination });
  assert.equal(selected.topic?.key, "MEM-2");
});
