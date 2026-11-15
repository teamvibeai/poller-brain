/** #447 review2: raw source boundaries are independent of Markdown visibility. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { firstCitations, type OwnershipRejection } from "../lib/citation-detect.js";
import { findTrimCandidates } from "../lib/mem-registry-trim-core.js";

type Assert = (condition: boolean, message: string) => void;

export function runRegistryIsolationTests(assert: Assert): void {
  const body = "Preserve the complete original lesson and every detail before trimming. ".repeat(10).trim();
  const registry = `| MEM-53 | ACTIVE | 2026-11-15 | — | ${body} |\n`;
  const heading = "## Complete promoted lesson [MEM-53]";
  const own = `${heading}\n[MEM-53] ${body}\n`;
  const foreign = "## Unrelated lesson [MEM-113]";
  const boundary = (continuation: string) => `${heading}\nShort introduction only.\n\nUse \`literal\n${continuation} <!--\` here.\n\n${foreign}\nUse \`-->\` literally.\n[MEM-53] ${body}`;
  // All nine review2 probes, through both real CLI modes. CommonMark ends
  // a quote fence when its container ends; indented code cannot cover prose.
  const cases: { name: string; text: string; covered: boolean; reason?: OwnershipRejection["reason"]; absent?: boolean }[] = [
    { name: "multiline_span_angle_continuation", text: boundary("<value>"), covered: false, reason: "foreign-key" },
    { name: "multiline_span_plain_control", text: boundary("value"), covered: false, reason: "foreign-key" },
    { name: "baseline", text: own, covered: true },
    { name: "same_indent_fence", text: "  ```sh\necho example\n  ```\n\n" + own, covered: true },
    { name: "less_indented_closing_fence", text: "  ```sh\necho example\n```\n\n" + own, covered: true },
    { name: "more_indented_closing_fence", text: "```sh\necho example\n  ```\n\n" + own, covered: true },
    { name: "quote_container_ends", text: "> ```sh\n> echo example\n\n" + own, covered: true },
    { name: "indented_code_after_literal_fences", text: `${heading}\n\n    \`\`\`\n    \`\`\`\n    [MEM-53] ${body}`, covered: false },
    { name: "setext_foreign_section", text: `${heading}\nShort introduction only.\n\nUnrelated lesson [MEM-113]\n-------------------------\n[MEM-53] ${body}`, covered: false, reason: "foreign-key" },
    // This matrix deliberately hides raw headings using real comments/fences.
    // Safety must hold without the visibility scanner recognizing those headings.
    ...["", "   ", "    ", "> ", "- "].flatMap((prefix) => ["comment", "fence"].map((hidden) => ({
      name: `raw_foreign_${hidden}_${JSON.stringify(prefix)}`,
      text: `${own}\n${hidden === "comment" ? "<!--" : "~~~"}\n${prefix}${foreign}\n${hidden === "comment" ? "-->" : "~~~"}\n[MEM-53] ${body}`,
      covered: false, reason: "uncertain-section" as const,
    }))),
    { name: "raw_unkeyed_boundary", text: `${heading}\n<!--\n### Generic hidden boundary\n-->\n[MEM-53] ${body}`, covered: false },
    { name: "raw_same_key_boundary", text: `${heading}\n<!--\n${heading}\n-->\n[MEM-53] ${body}`, covered: false },
    { name: "later_safe_section", text: `${heading}\n<!--\n${foreign}\n-->\n${own}`, covered: true, reason: "uncertain-section" },
  ];
  // Every top-level/explicit quote indentation pair is legal within the
  // same container. Container exits and indented code follow CommonMark.
  for (const marker of ["```", "~~~"]) {
    for (const container of ["", "> "]) {
      for (let opening = 0; opening <= 3; opening++) {
        for (let closing = 0; closing <= 3; closing++) {
          const text = `${container}${" ".repeat(opening)}${marker}sh\n${container}example\n${container}${" ".repeat(closing)}${marker}\n\n${own}`;
          assert(findTrimCandidates(registry, [{ file: "semantic/topic.md", text }]).contentCoverage[0]?.status === "covered",
            `registry #447: ${marker} container ${JSON.stringify(container)} indentation ${opening} -> ${closing}`);
        }
      }
    }
    for (const [opening, closing, covered] of [["", "    ", false], ["> ", "", false], ["> > ", "> ", true], ["    ", "        ", true]] as const) {
      const text = `${opening}${marker}sh\nexample\n${closing}${marker}\n\n${own}`;
      assert(findTrimCandidates(registry, [{ file: "semantic/topic.md", text }]).candidates.length === Number(covered),
        `registry #447: ${marker} container ${JSON.stringify(opening)} -> ${JSON.stringify(closing)} follows CommonMark`);
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-registry-isolation-"));
  try {
    fs.mkdirSync(path.join(root, "memory/semantic"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
    const source = path.join(root, "memory/MEM_REGISTRY.md");
    const run = (...args: string[]) => spawnSync(process.execPath,
      [...process.execArgv, path.resolve("skills/memory/scripts/mem-registry-trim.ts"), ...args],
      { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
    const report = (stdout: string, field: string): { key: string; status?: string; reason?: string }[] => {
      const line = stdout.split("\n").find((line) => line.startsWith(`${field}: `));
      return line ? JSON.parse(line.slice(field.length + 2)) : [];
    };
    for (const test of cases) {
      const label = `registry #447 review2 ${test.name}`;
      const destinations = [{ file: "semantic/topic.md", text: test.text }];
      const found = findTrimCandidates(registry, destinations);
      const expectedStatus = test.absent ? undefined : test.covered ? "covered" : "rejected";
      assert(found.candidates.length === (test.covered ? 1 : 0) && found.contentCoverage[0]?.status === expectedStatus,
        `${label}: raw guard and coverage eligibility`);
      if (test.reason) assert(found.ownershipRejections.some((r) => r.key === "MEM-53" && r.reason === test.reason),
        `${label}: explicit ${test.reason} diagnostic`);
      if (test.reason === "uncertain-section") {
        const scan = firstCitations(destinations);
        assert(test.covered || !scan.citations.has("MEM-53"), `${label}: uncertain section never supplies owned evidence`);
      }
      fs.writeFileSync(source, registry);
      fs.writeFileSync(path.join(root, "memory/semantic/topic.md"), test.text);
      const proposal = run();
      assert(proposal.status === 0 && report(proposal.stdout, "contentCoverage")[0]?.status === expectedStatus &&
        proposal.stdout.includes("MEM-53 →") === test.covered, `${label}: proposal eligibility`);
      assert(fs.readFileSync(source, "utf8") === registry, `${label}: proposal preserves registry bytes`);
      const apply = run("--apply", "--only", "MEM-53");
      assert(apply.status === (test.covered ? 0 : 1) && report(apply.stdout, "contentCoverage")[0]?.status === expectedStatus,
        `${label}: apply rechecks eligibility`);
      for (const result of [proposal, apply]) {
        if (test.reason) assert(report(result.stdout, "ownershipRejections").some((r) => r.key === "MEM-53" && r.reason === test.reason),
          `${label}: CLI emits ${test.reason} diagnostic`);
      }
      assert(test.covered ? fs.readFileSync(source, "utf8").includes("see semantic/topic.md") :
        fs.readFileSync(source, "utf8") === registry && apply.stderr.includes("no write performed"),
        `${label}: apply only rewrites safe covered content`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
