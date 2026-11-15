/** #530 slice2: isolated links/references and an unshrinkable shortest entry. */
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

// Relocation must be independent of the source file's reference namespace and
// directory. Scan conservatively, including syntax in prose/code/containers.
for (const mode of ["learnings", "registry"] as const) {
  for (const link of ["[policy][deploy]", "[deploy][]", "![policy][deploy]", "![deploy][]"]) {
    test(`${mode}: refuse reference syntax even without a definition: ${link}`, () => {
      const text = `# Rules\n\n${entry(mode, "MEM-1", `${link}. ${long}`)}\n`;
      const selected = selectTopic(mode, text, { rule });
      assert.equal(selected.topic, null);
      assert.match(selected.refusals.join("\n"), /MEM-1:.*reference/);
    });
  }
  for (const target of ["release-policy.pdf", "./policy.pdf", "../policy.pdf", "#deployment", "https://example.test/policy"]) {
    for (const indent of ["", " ", "  ", "   "]) {
      test(`${mode}: refuse definition with ${indent.length}-space indent and target ${target}`, () => {
        const definition = `${indent}[deploy]: ${target}`;
        const original = mode === "learnings" ? `## Deployment [MEM-1]\n${long}\n\n${definition}` :
          entry(mode, "MEM-1", `${definition} ${long}`);
        const selected = selectTopic(mode, `# Rules\n\n${original}\n`, { rule });
        assert.equal(selected.topic, null);
        assert.match(selected.refusals.join("\n"), /MEM-1:.*reference definition/);
      });
    }
  }
  for (const link of ["[Deploy   Policy]", "![Deploy   Policy]"]) {
    test(`${mode}: shortcut uses normalized definition anywhere in the file: ${link}`, () => {
      const text = `# Rules\n\n${entry(mode, "MEM-1", `${link}. ${long}`)}\n\n# Definitions\n\n   [deploy policy]: release-policy.pdf\n`;
      assert.equal(selectTopic(mode, text, { rule }).topic, null);
    });
  }
  for (const target of ["release-policy.pdf", "./policy.pdf", "../policy.pdf", "#deployment", "/policy.pdf", "//example.test/policy", ""]) {
    for (const image of ["", "!"]) {
      for (const angle of [false, true]) {
        const link = `${image}[policy](${angle ? `<${target}>` : target})`;
        test(`${mode}: refuse relative inline destination: ${link}`, () => {
          const text = `# Rules\n\n${entry(mode, "MEM-1", `${link}. ${long}`)}\n`;
          const selected = selectTopic(mode, text, { rule });
          assert.equal(selected.topic, null);
          assert.match(selected.refusals.join("\n"), /MEM-1:.*relative inline/);
        });
      }
    }
  }
  for (const target of ["https://example.test/policy.md#deploy", "http://example.test/policy", "mailto:release@example.test", "HTTPS://example.test/policy"]) {
    for (const image of ["", "!"]) {
      for (const angle of [false, true]) {
        const link = `${image}[policy](${angle ? `<${target}>` : target} "Policy")`;
        test(`${mode}: absolute inline destination remains relocatable: ${link}`, () => {
          const original = entry(mode, "MEM-1", `${link}. ${long}`);
          const text = `# Rules\n\n${original}\n`;
          const selected = selectTopic(mode, text, { rule });
          assert.equal(selected.topic?.key, "MEM-1", selected.refusals.join("\n"));
          const result = buildCondensation(mode, text, selected.topic!, { rule });
          assert.ok(result.destinationText.includes(original));
        });
      }
    }
  }
  for (const [definition, shortcut] of [["key", "Key"], ["STRAẞE", "Straße"]]) {
    test(`${mode}: shortcut label case normalization: ${shortcut}`, () => {
      const text = `# Rules\n\n[${definition}]: https://example.test/policy\n\n${entry(mode, "MEM-1", `Follow [${shortcut}]. ${long}`)}\n`;
      assert.equal(selectTopic(mode, text, { rule }).topic, null);
    });
  }
  for (const suffix of [" (https://example.test/policy)", "(https://example.test/policy"]) {
    test(`${mode}: a shortcut cannot hide behind an incomplete/adjacent inline link: ${suffix}`, () => {
      const text = `# Rules\n\n[deploy]: https://example.test/policy\n\n${entry(mode, "MEM-1", `[deploy]${suffix}. ${long}`)}\n`;
      assert.equal(selectTopic(mode, text, { rule }).topic, null);
    });
  }
  test(`${mode}: filter unsafe references before deterministic shortest-topic selection`, () => {
    const unsafe = entry(mode, "MEM-1", `Follow [policy][deploy]. ${long.slice(0, 700)}`);
    const text = `# Rules\n\n${unsafe}\n\n${entry(mode, "MEM-3", long)}\n\n${entry(mode, "MEM-2", long)}\n`;
    const first = selectTopic(mode, text, { rule });
    assert.equal(first.topic?.key, "MEM-3");
    assert.match(first.refusals.join("\n"), /MEM-1:.*reference/);
    assert.deepEqual(selectTopic(mode, text, { rule }), first);
    assert.ok(buildCondensation(mode, text, first.topic!, { rule }).after.includes(unsafe));
  });
}

for (const indent of ["", " ", "  ", "   "]) {
  for (const reference of ["[policy][deploy]", "[deploy][]", "[deploy]"]) {
    test(`learnings: preserve reverse dependency (${indent.length}-space definition, ${reference})`, () => {
      const original = `## Deployment [MEM-1]\n${long}\n\n${indent}[deploy]: https://example.test/policy`;
      const text = `# Rules\n\n${original}\n\n## Receipts [MEM-2]\nKeep ${reference}.\n`;
      const selected = selectTopic("learnings", text, { rule });
      assert.equal(selected.topic, null);
      assert.match(selected.refusals.join("\n"), /MEM-1:.*reference definition/);
    });
  }
}

for (const mode of ["learnings", "registry"] as const) {
  for (const variant of ["reverse-definition", "relative-definition", "fragment-definition", "relative-inline", "fragment-inline", "absolute-inline"]) {
    if (mode === "registry" && variant.includes("definition")) continue; // Rows cannot own standalone definitions.
    test(`${mode}: CLI link isolation propose/apply (${variant})`, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "condensation-isolation-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const brain = path.join(root, "brain"), scratch = path.join(root, "proposal");
      const absolute = variant === "absolute-inline";
      const target = variant.startsWith("fragment") ? "#deployment" : "release-policy.pdf";
      const original = variant.includes("definition") ?
        `## Deployment [MEM-1]\n${long}\n\n   [deploy]: ${variant === "reverse-definition" ? "https://example.test/policy" : target}` :
        entry(mode, "MEM-1", `Follow [policy](${absolute ? "https://example.test/policy.md#deploy" : target}). ${long}`);
      const retained = variant === "reverse-definition" ? "\n\n## Receipts [MEM-2]\nKeep [policy][deploy]." : "";
      const text = `# Rules\n\n${original}${retained}\n`;
      fs.mkdirSync(path.join(brain, "memory/core"), { recursive: true });
      fs.writeFileSync(path.join(brain, "CLAUDE.md"), "fixture\n");
      fs.writeFileSync(path.join(brain, sources[mode]), text);
      const env = { ...process.env, BRAIN_ROOT: brain, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };
      const git = (...args: string[]) => {
        const r = spawnSync("git", args, { cwd: brain, env, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trimEnd();
      };
      const cli = (...args: string[]) => spawnSync(process.execPath,
        [...process.execArgv, path.join(repo, "skills/memory/scripts/mem-condense.ts"), ...args], { cwd: repo, env, encoding: "utf8" });
      git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
      const head = git("rev-parse", "HEAD");
      const proposal = cli("--mode", mode, "--scratch", scratch, "--rule", rule);
      assert.equal(proposal.status, 0, proposal.stdout + proposal.stderr);
      assert.equal(fs.readFileSync(path.join(brain, sources[mode]), "utf8"), text);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("status", "--porcelain"), "");
      if (!absolute) {
        assert.match(proposal.stdout, /refused: MEM-1:.*(?:reference definition|relative inline)/);
        assert.ok(!fs.existsSync(scratch), "unsafe-only source produces no plan");
        // A later safe topic must still be proposed and applied, retaining all
        // unsafe bytes and any incoming reference in their original context.
        const safe = mode === "learnings" ? `## Safe alternative [MEM-3]\n${long}` : entry(mode, "MEM-3", long);
        fs.writeFileSync(path.join(brain, sources[mode]), `${text}\n${safe}\n`);
        git("add", "."); git("commit", "-qm", "safe alternative");
        const next = cli("--mode", mode, "--scratch", scratch, "--rule", rule);
        assert.equal(next.status, 0, next.stdout + next.stderr);
        assert.match(next.stdout, /refused: MEM-1:.*(?:reference definition|relative inline)/);
      }
      const planFile = path.join(scratch, "plan.json"), plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
      assert.equal(plan.topic.key, absolute ? "MEM-1" : "MEM-3");
      fs.writeFileSync(path.join(brain, ".git/consolidation-start"), `v1 2026-11-15 ${git("rev-parse", "HEAD")}\n`);
      const applied = cli("--apply", "--plan", planFile, "--only", `${plan.topic.key}@${plan.topic.start}`, "--cycle-date", "2026-11-15");
      assert.equal(applied.status, 0, applied.stdout + applied.stderr);
      assert.equal(fs.readFileSync(path.join(brain, sources[mode]), "utf8"), plan.sourceAfter);
      assert.equal(fs.readFileSync(path.join(brain, "memory", plan.destination), "utf8"), plan.destinationText);
      assert.ok(absolute ? plan.destinationText.includes(original) : plan.sourceAfter.includes(text.trimEnd()));
      assert.equal(git("status", "--porcelain"), "");
    });
  }
}
