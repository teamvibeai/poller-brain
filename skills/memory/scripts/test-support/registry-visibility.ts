/** #447 review1: visibility guards must survive the real proposal/apply path. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { findTrimCandidates } from "../lib/mem-registry-trim-core.js";

export function runRegistryVisibilityTests(assert: (condition: boolean, message: string) => void): void {
  const body = "Retain the original full lesson and every detail before approving any trim. ".repeat(8).trim();
  const registry = `| MEM-53 | ACTIVE | 2026-11-15 | — | ${body} |\n`;
  const own = "## Correct full lesson [MEM-53]\nShort introduction only.\n";
  const foreign = "## Unrelated lesson [MEM-113]";
  const lesson = `[MEM-53] ${body}`;
  const boundary = (open: string, close: string) => `${own}\n${open}\n\n${foreign}\n${close}\n${lesson}`;
  const cases = [
    { label: "inline code comment", text: boundary("Use `<!--` literally.", "Use `-->` literally.") },
    { label: "double backtick span", text: boundary("Use `` ` <!-- `` literally.", "Use `` --> ` `` literally.") },
    { label: "unequal inner backtick runs", text: boundary("Use `` <!-- ` `` literally.", "Use `-->` literally.") },
    { label: "multiline code span", text: boundary("Use `literal\n token <!--` here.", "Use `-->` literally.") },
    { label: "quoted multiline code span", text: boundary("> Use `literal\n> token <!--` here.", "Use `-->` literally.") },
    { label: "quote indentation may vary", text: boundary("> Use `literal\n >token <!--` here.", "Use `-->` literally.") },
    { label: "lazy quote paragraph continuation", text: boundary("> Use `literal\n token <!--` here.", "Use `-->` literally.") },
    { label: "escaped comment opener", text: boundary("Use \\<!-- literally.", "Use --> literally.") },
    { label: "odd backslash run", text: boundary("Use \\\\\\<!-- literally.", "Use --> literally.") },
    { label: "real comment control", text: boundary("<!--", "-->"), covered: true },
    { label: "even backslash run opens comment", text: boundary("Use \\\\<!--", "-->"), covered: true },
    { label: "escaped backtick is not a span", text: boundary("Use \\`<!--", "-->"), covered: true },
    { label: "unmatched backtick is not a span", text: boundary("Use `<!--", "-->"), covered: true },
    { label: "code span cannot cross heading boundary", text: boundary("Use `<!--", "--> trailing `"), covered: true },
    { label: "real comment following code span", text: boundary("Use `literal` <!--", "-->"), covered: true },
    { label: "backslash inside span does not escape closing backtick", text: boundary("Use `\\`<!--", "-->"), covered: true },
    { label: "comment closer is raw HTML", text: `${own}\n<!-- hidden \\-->\n${foreign}\n${lesson}` },
    { label: "commented lesson control", text: `${own}\n<!--\n${lesson}\n-->` },
    ...["```", "~~~"].flatMap((marker) => [
      { label: `column zero ${marker} control`, text: `${own}\n${marker}md\n${lesson}\n${marker}` },
      { label: `list fence ${marker}`, text: `${own}\n- Sample input:\n\n    ${marker}md\n    ${foreign}\n    ${lesson}\n    ${marker}` },
      { label: `nested ordered list fence ${marker}`, text: `${own}\n1. Example:\n\n   - Nested:\n\n       ${marker}md\n       ${lesson}\n       ${marker}` },
      { label: `list marker fence ${marker}`, text: `${own}\n- ${marker}md\n  ${lesson}\n  ${marker}` },
      { label: `blockquote list fence ${marker}`, text: `${own}\n> - ${marker}md\n>   ${lesson}\n>   ${marker}` },
      { label: `tab indented fence ${marker}`, text: `${own}\n- Example:\n\n\t${marker}md\n\t${lesson}\n\t${marker}` },
      { label: `uncertain deeper closing fence ${marker}`, text: `${own}\n- Example:\n\n    ${marker}md\n        ${marker}\n    ${lesson}` },
      { label: `content after list fence ${marker}`, text: `${own}\n- ${marker}md\n  <!-- fake comment\n  ${foreign}\n  ${marker}\n${lesson}`, covered: true },
    ]),
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-registry-visibility-"));
  try {
    fs.mkdirSync(path.join(root, "memory/semantic"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
    const registryPath = path.join(root, "memory/MEM_REGISTRY.md");
    const run = (...args: string[]) => spawnSync(process.execPath,
      [...process.execArgv, path.resolve("skills/memory/scripts/mem-registry-trim.ts"), ...args],
      { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
    for (const test of cases) {
      const label = `registry #447 review1 ${test.label}`;
      const covered = test.covered === true;
      const found = findTrimCandidates(registry, [{ file: "semantic/topic.md", text: test.text }]);
      assert(found.contentCoverage[0]?.status === (covered ? "covered" : "rejected") &&
        found.candidates.length === (covered ? 1 : 0), `${label}: coverage and candidate eligibility`);
      fs.writeFileSync(registryPath, registry);
      fs.writeFileSync(path.join(root, "memory/semantic/topic.md"), test.text);
      const proposal = run();
      const readCoverage = (stdout: string): { key: string; status: string }[] => {
        const report = stdout.split("\n").find((line) => line.startsWith("contentCoverage: "));
        return report ? JSON.parse(report.slice("contentCoverage: ".length)) : [];
      };
      assert(proposal.status === 0 && readCoverage(proposal.stdout)[0]?.status === (covered ? "covered" : "rejected") &&
        proposal.stdout.includes("MEM-53 →") === covered, `${label}: CLI proposal reports coverage and eligibility`);
      assert(fs.readFileSync(registryPath, "utf8") === registry, `${label}: proposal preserves registry`);
      const apply = run("--apply", "--only", "MEM-53");
      assert(apply.status === (covered ? 0 : 1) &&
        readCoverage(apply.stdout)[0]?.status === (covered ? "covered" : "rejected"), `${label}: CLI apply rechecks coverage`);
      assert(covered ? fs.readFileSync(registryPath, "utf8").includes("see semantic/topic.md") :
        apply.stderr.includes("no write performed") && fs.readFileSync(registryPath, "utf8") === registry,
      `${label}: apply only rewrites covered content`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
