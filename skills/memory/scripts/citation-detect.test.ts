/** CommonMark construction regressions, including the exact review3 probes. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { firstCitations } from "./lib/citation-detect.js";
import { findTrimCandidates } from "./lib/mem-registry-trim-core.js";
import { findLearningsTrimCandidates } from "./lib/mem-learnings-trim-core.js";
import { findMistakesTrimCandidates } from "./lib/mem-mistakes-trim-core.js";

let passed = 0, failed = 0;
function assert(ok: boolean, label: string): void {
  if (ok) passed++; else { failed++; console.error(`FAIL: ${label}`); }
}
const body = "Retain the entire original lesson and every detail before approving a trim. ".repeat(8).trim();
const registry = `| MEM-53 | ACTIVE | 2026-11-15 | — | ${body} |\n`;
const entry = `- [MEM-53] ${body}\n`;
const title = "Complete promoted lesson [MEM-53]";
const own = `## ${title}\n[MEM-53] ${body}\n`;
const cases = [
  { name: "safe-control", text: own, covered: true },
  // All four fixtures from review3/probe.ts, plus the safe control above.
  { name: "real-comment", text: `<!--\n${own}-->`, covered: false, hidden: true },
  { name: "comment-interrupts-inline-span", text: 'Use `literal\n<!--` here.\n\n' + own + '-->\n', covered: false, hidden: true },
  { name: "multiline-setext-foreign-owner", text: `## ${title}\nShort introduction only.\n\nUnrelated lesson [MEM-113]\n${body}\nLast title line\n----------------\nUnrelated body.`, covered: false },
  { name: "fence-after-comment", text: `## ${title}\nShort introduction only.\n\n<!-- end here -->\n~~~\n${body}\n~~~`, covered: false },
  { name: "setext-owned", text: `${title}\n================\n[MEM-53] ${body}\n`, covered: true },
  { name: "multiline-setext-owned", text: `Complete promoted\nlesson [MEM-53]\n================\n[MEM-53] ${body}\n`, covered: true },
  { name: "multiline-setext-multiple-owners", text: `Lesson [MEM-53]\nand [MEM-113]\nLast title line\n================\n[MEM-53] ${body}\n`, covered: false, hidden: true },
  { name: "list-fence-ends", text: '- ```md\n  example\n  ```\n\n' + own, covered: true },
  { name: "quote-fence-ends", text: '> ```md\n> example\n\n' + own, covered: true },
  { name: "indented-code-is-not-coverage", text: `## ${title}\n\n    [MEM-53] ${body}\n`, covered: false },
  { name: "html-block-is-not-heading", text: `<div>\n${own}</div>\n`, covered: false, hidden: true },
  { name: "atx-interrupts-unmatched-span", text: `Use \`literal\n## ${title}\n[MEM-53] ${body}\nend\`\n`, covered: true }, // ATX interrupts a paragraph, so this is a real heading.
  { name: "foreign-raw-heading-in-code", text: own + '\n~~~\n## Hidden [MEM-113]\n~~~\n', covered: false, hidden: true, uncertain: true },
  { name: "foreign-raw-heading-in-html", text: own + '\n<!--\n## Hidden [MEM-113]\n-->\n', covered: false, hidden: true, uncertain: true },
  { name: "foreign-raw-heading-in-inline-code", text: own + '\nUse `literal\n    ## Hidden [MEM-113]\nend`\n', covered: false, hidden: true, uncertain: true },
];
// ATX starts a block even after an unmatched backtick; a real inline span
// continuing with '<value>' is instead one inline node, with no fake blocks.
cases.push({ name: "multiline-span-angle-comment", text: `## ${title}\nShort introduction only.\n\nUse \`literal\n<value> <!--\` here.\n\n## Unrelated lesson [MEM-113]\nUse \`-->\` literally.\n[MEM-53] ${body}`, covered: false });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "commonmark-citations-"));
try {
  fs.mkdirSync(path.join(root, "memory/core"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory/semantic"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture\n");
  for (const test of cases) {
    const dest = [{ file: "semantic/topic.md", text: test.text }];
    const scan = firstCitations(dest);
    const found = findTrimCandidates(registry, dest);
    assert(found.candidates.length === Number(test.covered), `${test.name}: registry coverage eligibility`);
    if (test.hidden) {
      assert(!scan.citations.has("MEM-53"), `${test.name}: no owned citation`);
      assert(findLearningsTrimCandidates(entry, dest).candidates.length === 0, `${test.name}: learnings rejects`);
      assert(findMistakesTrimCandidates(entry, dest).candidates.length === 0, `${test.name}: mistakes rejects`);
    }
    if (test.uncertain) assert(scan.ownershipRejections.some((r) => r.key === "MEM-53" && r.reason === "uncertain-section" && r.rawHeading?.owners.includes("MEM-113")), `${test.name}: independent raw veto`);
    if (test.name === "multiline-setext-foreign-owner") {
      assert(!scan.citations.get("MEM-53")?.sectionText.includes(body), `${test.name}: first heading line ends previous section`);
      assert(scan.citations.get("MEM-113")?.heading === `Unrelated lesson [MEM-113] ${body} Last title line`, `${test.name}: full AST title and owner`);
    }
    // Real proposal and apply, including all three consumers for hidden evidence.
    for (const kind of test.hidden ? ["registry", "learnings", "mistakes"] : ["registry"]) {
      const source = path.join(root, "memory", kind === "registry" ? "MEM_REGISTRY.md" : `core/${kind.toUpperCase()}.md`);
      const original = kind === "registry" ? registry : entry;
      fs.writeFileSync(source, original);
      fs.writeFileSync(path.join(root, "memory/semantic/topic.md"), test.text);
      const run = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv,
        path.resolve(`skills/memory/scripts/mem-${kind}-trim.ts`), ...args], { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
      const proposal = run();
      assert(proposal.status === 0 && fs.readFileSync(source, "utf8") === original, `${test.name}/${kind}: proposal succeeds without writing`);
      const apply = run("--apply", "--only", "MEM-53");
      assert(apply.status === (test.covered ? 0 : 1), `${test.name}/${kind}: apply eligibility: ${apply.stderr}`);
      assert(test.covered ? fs.readFileSync(source, "utf8").includes("see semantic/topic.md") :
        fs.readFileSync(source, "utf8") === original && apply.stderr.includes("no write performed"), `${test.name}/${kind}: only safe selection writes`);
    }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`${passed} assertions passed, ${failed} failed`);
if (failed) process.exitCode = 1;
