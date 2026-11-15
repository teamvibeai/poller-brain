/** Shared #447 regression matrix, run by each trim consumer's complete suite. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { firstCitations, type DestinationFile, type OwnershipRejection } from "../lib/citation-detect.js";
import { findTrimCandidates } from "../lib/mem-registry-trim-core.js";
import { findLearningsTrimCandidates } from "../lib/mem-learnings-trim-core.js";
import { findMistakesTrimCandidates } from "../lib/mem-mistakes-trim-core.js";

type Kind = "registry" | "learnings" | "mistakes";
type Assert = (condition: boolean, message: string) => void;
const BODY = "Preserve the original incident and every detail before approving a trim. ".repeat(8).trim();
const DATED = "MEM-2026-11-07-203000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_DATED = "MEM-2026-11-07-203001-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const heading = (key: string) => `## Complete promoted incident lesson [${key}]`;
const content = (key: string) => `[${key}] ${BODY}`;

export function runTrimOwnershipTests(kind: Kind, assert: Assert): void {
  const source = (key: string) => kind === "registry"
    ? `| ${key} | ACTIVE | 2026-11-15 | — | ${BODY} |\n`
    : `- [${key}] ${BODY}\n`;
  const find = (key: string, destinations: DestinationFile[]) => kind === "registry"
    ? findTrimCandidates(source(key), destinations)
    : kind === "learnings" ? findLearningsTrimCandidates(source(key), destinations)
    : findMistakesTrimCandidates(source(key), destinations);
  const cases: { label: string; key?: string; text: string; accepted?: number; reason?: OwnershipRejection["reason"] }[] = [
    { label: "MEM-53 under MEM-113", text: `${heading("MEM-113")}\n${content("MEM-53")}`, reason: "foreign-key" },
    { label: "MEM-98 under MEM-84", key: "MEM-98", text: `${heading("MEM-84")}\n${content("MEM-98")}`, reason: "foreign-key" },
    { label: "same-key heading is itself a citation", text: `${heading("MEM-53")}\n${content("MEM-53")}`, accepted: 1 },
    { label: "early wrong then later correct", text: `${heading("MEM-113")}\n${content("MEM-53")}\n${heading("MEM-53")}\n${content("MEM-53")}`, accepted: 3, reason: "foreign-key" },
    { label: "obsolete then later correct", text: `${heading("MEM-53:obsolete")}\n${content("MEM-53")}\n${heading("MEM-53")}\n${content("MEM-53")}`, accepted: 3, reason: "obsolete-owner" },
    { label: "generic heading", text: `## Generic destination lesson\n${content("MEM-53")}`, reason: "missing-key" },
    { label: "nested generic heading", text: `## Generic parent\n### Generic child\n${content("MEM-53")}`, reason: "missing-key" },
    // Exclude the ancestor's own citation as a pointer: only the child's line could qualify.
    { label: "unkeyed child does not inherit keyed ancestor", text: `## [MEM-53] → see semantic/parent.md\n### Generic child\n${content("MEM-53")}`, reason: "missing-key" },
    { label: "missing heading", text: content("MEM-53"), reason: "missing-heading" },
    { label: "empty heading ends ownership", text: `## [MEM-53] → see semantic/parent.md\n###\n${content("MEM-53")}`, reason: "missing-key" },
    { label: "multi-key heading", text: `## Joint lesson [MEM-53][MEM-113]\n${content("MEM-53")}`, reason: "multi-key" },
    { label: "compact slash heading", text: `## Joint lesson [MEM-53/113]\n${content("MEM-53")}`, reason: "multi-key" },
    { label: "compact comma heading", text: `## Joint lesson [MEM-53,113]\n${content("MEM-53")}`, reason: "multi-key" },
    { label: "multi-key heading with leading subject", text: `## [MEM-53] Joint lesson referring to MEM-113\n${content("MEM-53")}`, reason: "multi-key" },
    { label: "MEM-5 cannot own MEM-53", text: `${heading("MEM-5")}\n${content("MEM-53")}`, reason: "foreign-key" },
    { label: "MEM-53 cannot own MEM-5", key: "MEM-5", text: `${heading("MEM-53")}\n${content("MEM-5")}`, reason: "foreign-key" },
    { label: "dated same-key", key: DATED, text: `${heading(DATED)}\n${content(DATED)}`, accepted: 1 },
    { label: "dated foreign key with same year", key: DATED, text: `${heading(OTHER_DATED)}\n${content(DATED)}`, reason: "foreign-key" },
    { label: "obsolete heading", text: `${heading("MEM-53:obsolete")}\n${content("MEM-53")}`, reason: "obsolete-owner" },
    { label: "dated obsolete heading", key: DATED, text: `${heading(`${DATED}:obsolete`)}\n${content(DATED)}`, reason: "obsolete-owner" },
    { label: "fenced backticks", text: `\x60\x60\x60md\n${heading("MEM-53")}\n${content("MEM-53")}\n\x60\x60\x60` },
    { label: "fenced tildes", text: `~~~md\n${heading("MEM-53")}\n${content("MEM-53")}\n~~~` },
    { label: "commented heading and citation", text: `<!--\n${heading("MEM-53")}\n${content("MEM-53")}\n-->` },
    { label: "inline commented owner", text: `## Generic lesson <!-- [MEM-53] -->\n${content("MEM-53")}`, reason: "missing-key" },
    { label: "inline commented foreign key", text: `${heading("MEM-53")} <!-- [MEM-113] -->\n${content("MEM-53")}`, reason: "uncertain-section" },
    { label: "fake fenced heading cannot govern later text", text: `~~~\n${heading("MEM-53")}\n~~~\n${content("MEM-53")}`, reason: "missing-heading" },
    { label: "fake commented heading cannot govern later text", text: `<!--\n${heading("MEM-53")}\n-->\n${content("MEM-53")}`, reason: "missing-heading" },
    { label: "raw hidden foreign headings veto ownership", text: `${heading("MEM-53")}\n~~~\n${heading("MEM-113")}\n<!--\n~~~\n<!--\n${heading("MEM-84")}\n-->\n${content("MEM-53")}`, reason: "uncertain-section" },
    { label: "raw guard rejects even preceding full content", text: `${heading("MEM-53")}\n${content("MEM-53")}\n<!--\n${heading("MEM-113")}\n-->`, reason: "uncertain-section" },
    { label: "raw guard scans past a hidden generic boundary", text: `${heading("MEM-53")}\n${content("MEM-53")}\n<!--\n### Generic boundary\n${heading("MEM-113")}\n-->`, reason: "uncertain-section" },
    { label: "raw guard does not consume later valid evidence", text: `${heading("MEM-53")}\n<!--\n${heading("MEM-113")}\n-->\n${heading("MEM-53")}\n${content("MEM-53")}`, accepted: 5, reason: "uncertain-section" },
    { label: "indented and closing-hash heading", text: `   ${heading("MEM-53")} ###\n${content("MEM-53")}`, accepted: 1 },
    { label: "index line remains rejected", text: `## [MEM-53] → see semantic/parent.md\n| MEM-53 | semantic/other.md |\n${BODY}` },
  ];
  for (const test of cases) {
    const key = test.key ?? "MEM-53";
    const destinations = [{ file: "semantic/topic.md", text: test.text }];
    const found = find(key, destinations);
    const label = `${kind} #447 ${test.label}`;
    const candidate = found.candidates.find((c) => c.key === key);
    assert(test.accepted ? candidate?.line === test.accepted : !candidate, `${label}: candidate eligibility and location`);
    if (test.reason) {
      const rejected = found.ownershipRejections.find((r) => r.key === key && r.reason === test.reason);
      assert(!!rejected && rejected.file === "semantic/topic.md" && rejected.line > 0 &&
        typeof rejected.lineText === "string" && (rejected.heading === null || typeof rejected.heading === "string"),
      `${label}: additive rejection includes key, file, line, heading and reason`);
      if (test.reason === "uncertain-section") {
        const raw = rejected?.rawHeading;
        assert(!!raw && raw.line > 0 && test.text.split("\n")[raw.line - 1] === raw.lineText &&
          raw.owners.some((owner) => owner !== key), `${label}: diagnostic locates the raw foreign heading`);
      }
    }
    if (!test.accepted && !test.reason) {
      assert(!found.ownershipRejections.some((r) => r.key === key), `${label}: hidden/index evidence does not become an ownership rejection`);
    }
    assert(JSON.stringify(found) === JSON.stringify(find(key, destinations)), `${label}: deterministic report`);
  }

  const acrossFiles = [
    { file: "semantic/z-correct.md", text: `${heading("MEM-53")}\n${content("MEM-53")}` },
    { file: "semantic/a-wrong.md", text: `${heading("MEM-113")}\n${content("MEM-53")}` },
  ];
  const across = find("MEM-53", acrossFiles);
  assert(across.candidates[0]?.file === "semantic/z-correct.md", `${kind} #447: scan past rejected earlier file`);
  assert(JSON.stringify(across) === JSON.stringify(find("MEM-53", [...acrossFiles].reverse())), `${kind} #447: file order is deterministic`);

  // A heading can be an index pointer while its owned body supplies subject-position evidence.
  const subject = firstCitations([{ file: "semantic/subject.md", text:
    `## [MEM-53] → see semantic/parent.md\n- [MEM-53] Condensed lesson references MEM-113.\n- [MEM-53/113] Joint subjects.\n` }]);
  assert(subject.citations.get("MEM-53")?.line === 2 && !subject.citations.has("MEM-113"),
    `${kind} #447: existing sole-subject and index rules still apply inside owned section`);
  const priority = firstCitations([{ file: "semantic/priority.md", text:
    `## [MEM-53] → see semantic/parent.md\nUnowned mixed context MEM-53 MEM-113.\n- [MEM-53] Condensed lesson mentions MEM-113.\nDedicated later lesson [MEM-53]` }]);
  assert(priority.citations.get("MEM-53")?.line === 3 && !priority.citations.has("MEM-113"),
    `${kind} #447: skip ambiguous prose, keep first sole-subject evidence before later dedicated line`);
  const nested = find("MEM-53", [{ file: "semantic/nested.md", text:
    `${heading("MEM-53")}\n${BODY}\n### Generic child\n${content("MEM-53")}` }]);
  assert(nested.candidates[0]?.line === 1 && nested.ownershipRejections.some((r) => r.key === "MEM-53" && r.line === 4 && r.reason === "missing-key"),
    `${kind} #447: parent heading may cite itself, but does not own the unkeyed child's citation`);

  if (kind === "registry") {
    for (const outside of [
      `${BODY}\n${heading("MEM-53")}\nCondensed prose [MEM-53]`,
      `${heading("MEM-53")}\nCondensed prose [MEM-53]\n${heading("MEM-113")}\n${BODY}`,
      `${heading("MEM-53")}\nCondensed prose [MEM-53]\n### Unkeyed child\n${BODY}`,
      `${heading("MEM-53")}\n~~~\n${BODY}\n~~~`,
      `${heading("MEM-53")}\n<!--\n${BODY}\n-->`,
      `${heading("MEM-53")}\n<!-- ${BODY} -->`,
      `${heading("MEM-53")}\nCondensed prose [MEM-53]\n${heading("MEM-53")}\n${BODY}`,
    ]) {
      const found = findTrimCandidates(source("MEM-53"), [{ file: "semantic/outside.md", text: outside }]);
      assert(found.candidates.length === 0 && found.contentCoverage[0]?.status === "rejected",
        "registry #447: whole-file, nested, hidden or later separate section text cannot cover accepted section");
    }
  }

  // Real proposal/apply paths: proposals report rejections and never write;
  // excluded --only selectors fail before source or archival changes.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mem-${kind}-ownership-`));
  try {
    fs.mkdirSync(path.join(root, "memory/core"), { recursive: true });
    fs.mkdirSync(path.join(root, "memory/semantic"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture");
    const sourceFile = path.join(root, "memory", kind === "registry" ? "MEM_REGISTRY.md" : `core/${kind.toUpperCase()}.md`);
    const original = source("MEM-53") + source("MEM-98");
    fs.writeFileSync(sourceFile, original);
    fs.writeFileSync(path.join(root, "memory/semantic/topic.md"),
      `${heading("MEM-113")}\n${content("MEM-53")}\n${heading("MEM-84")}\n${content("MEM-98")}`);
    const run = (args: string[]) => spawnSync(process.execPath,
      [...process.execArgv, path.resolve(`skills/memory/scripts/mem-${kind}-trim.ts`), ...args],
      { encoding: "utf8", env: { ...process.env, BRAIN_ROOT: root } });
    const proposal = run([]);
    const report = proposal.stdout.split("\n").find((line) => line.startsWith("ownershipRejections: "));
    const rejections: OwnershipRejection[] = report ? JSON.parse(report.slice("ownershipRejections: ".length)) : [];
    assert(proposal.status === 0 && ["MEM-53", "MEM-98"].every((key) => rejections.some((r) => r.key === key && r.reason === "foreign-key")),
      `${kind} #447 CLI: both foreign-heading rejections printed as JSON`);
    assert(fs.readFileSync(sourceFile, "utf8") === original, `${kind} #447 CLI: propose writes nothing`);
    for (const key of ["MEM-53", "MEM-98"]) {
      const apply = run(["--apply", "--only", key]);
      assert(apply.status === 1 && apply.stderr.includes("no write performed"), `${kind} #447 CLI: excluded selector refuses apply`);
      assert(fs.readFileSync(sourceFile, "utf8") === original && !fs.existsSync(path.join(root, "memory/episodic")),
        `${kind} #447 CLI: refused apply preserves source and creates no archive`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
