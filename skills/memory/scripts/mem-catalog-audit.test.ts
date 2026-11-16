#!/usr/bin/env npx tsx
/** Fixture/CLI tests: npx tsx skills/memory/scripts/mem-catalog-audit.test.ts */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { auditCatalog, formatAudit } from "./lib/mem-catalog-audit-core.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-catalog-test-"));
const cli = path.resolve("skills/memory/scripts/mem-catalog-audit.ts");
let passed = 0;
function write(brain: string, file: string, text: string | Buffer) {
  const target = path.join(brain, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function fixture(name: string) {
  const brain = path.join(root, name);
  write(brain, "CLAUDE.md", "# Fixture brain\n");
  for (const tier of ["core", "semantic", "procedural"]) fs.mkdirSync(path.join(brain, "memory", tier), { recursive: true });
  write(brain, "memory/SUMMARY.md", catalog());
  return brain;
}
function catalog(...lines: string[]) { return "## Memory Catalog\n" + lines.join("\n") + "\n"; }
function link(file: string) { return `- [Entry](<${file}>)`; }
function audit(brain: string, required?: string) { return auditCatalog(path.join(brain, "memory"), required); }
function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`PASS ${name}`);
}
function runCli(brain: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [...process.execArgv, cli, ...args], {
    cwd: path.join(brain, "memory", "semantic"),
    env: { ...process.env, BRAIN_ROOT: brain }, encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}
function snapshot(brain: string): unknown[] {
  const result: unknown[] = [];
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      result.push([path.relative(brain, file), stat.mode, stat.mtimeMs,
        stat.isFile() ? fs.readFileSync(file).toString("base64") : stat.isSymbolicLink() ? fs.readlinkSync(file) : null]);
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(brain);
  return result;
}

try {
  for (const registry of [false, true]) test(`zero promotions, registry ${registry ? "present with all ACTIVE keys preserved" : "absent"}`, () => {
    const brain = fixture(`zero-${registry}`);
    write(brain, "memory/semantic/new.md", "[MEM-1] A session-created fact\n");
    if (registry) write(brain, "memory/MEM_REGISTRY.md", "| MEM-1 | ACTIVE | 2026-11-15 | — | A fact |\n");
    // No tier writes/promotions by consolidation; it must still see the new file.
    const result = runCli(brain, "--json");
    assert.equal(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, "warning");
    assert.equal(value.total, 1);
    assert.equal(value.uncatalogued, 1);
    assert.deepEqual(value.missingPaths, ["semantic/new.md"]);
    assert.equal(value.catalogued, 0);
    assert.deepEqual(value.indexPaths, ["SUMMARY.md"]);
    assert.ok(Number.isFinite(Date.parse(value.measuredAt)));
  });

  test("independent clean, drifted and repaired measurements; explicit 0/0", () => {
    const brain = fixture("drift");
    assert.match(formatAudit(audit(brain)), /Uncatalogued: 0\/0/);
    write(brain, "memory/semantic/one.md", "one");
    write(brain, "memory/SUMMARY.md", catalog(link("semantic/one.md")));
    const clean = audit(brain);
    assert.equal(clean.status, "complete");
    assert.match(formatAudit(clean), /Uncatalogued: 0\/1/);
    write(brain, "reports/previous-memory-consolidation.md", formatAudit(clean));
    write(brain, "memory/semantic/two.md", "two");
    const drift = audit(brain);
    assert.equal(drift.uncatalogued, 1);
    assert.deepEqual(drift.missingPaths, ["semantic/two.md"]);
    write(brain, "memory/SUMMARY.md", catalog(link("semantic/one.md"), link("semantic/two.md")));
    assert.equal(audit(brain).uncatalogued, 0);
    assert.equal(audit(brain).total, 2);
  });

  test("custom linked catalogs, nested pages, relative paths, cycles and a bounded SUMMARY", () => {
    const brain = fixture("custom");
    write(brain, "memory/SUMMARY.md", catalog("- catalog: [Full catalog](<index.md>)"));
    write(brain, "memory/index.md", catalog("- catalog: [More](<catalogs/more.md>)", link("./core/../semantic/one.md#details")));
    write(brain, "memory/catalogs/more.md", catalog("- catalog: [Back](<../index.md>)", link("../procedural/two.md")));
    write(brain, "memory/semantic/one.md", "one");
    write(brain, "memory/procedural/two.md", "two");
    const result = audit(brain, "./index.md");
    assert.equal(result.status, "complete");
    assert.equal(result.catalogued, 2);
    assert.deepEqual(result.indexPaths, ["SUMMARY.md", "catalogs/more.md", "index.md"]);
    assert.deepEqual(result.cycles, ["catalogs/more.md -> index.md"]);
    assert.ok(fs.statSync(path.join(brain, "memory/SUMMARY.md")).size < 9000);
    assert.equal(runCli(brain, "--catalog", "index.md").status, 0);
  });

  test("unlinked custom page is never followed, even via a content file", () => {
    const brain = fixture("unlinked");
    write(brain, "memory/SUMMARY.md", catalog(link("semantic/one.md"), link("index.md")));
    write(brain, "memory/semantic/one.md", catalog("- catalog: [Hidden](<../index.md>)", link("two.md")));
    write(brain, "memory/semantic/two.md", "two");
    write(brain, "memory/index.md", catalog(link("semantic/two.md")));
    const result = audit(brain, "index.md");
    assert.equal(result.status, "incomplete");
    assert.equal(result.uncatalogued, null);
    assert.deepEqual(result.indexPaths, ["SUMMARY.md"]);
    assert.deepEqual(result.missingPaths, ["semantic/two.md"]);
    assert.match(result.errors.join("\n"), /not declared reachable/);
    assert.equal(runCli(brain, "--catalog", "index.md").status, 1);
  });

  test("large full catalog preserves SUMMARY budget and counts each file once", () => {
    const brain = fixture("large");
    const paths = Array.from({ length: 400 }, (_, i) => `semantic/nested/topic-${i}.md`);
    for (const file of paths) write(brain, `memory/${file}`, "topic");
    write(brain, "memory/SUMMARY.md", catalog("- catalog: [Full inventory](<index.md>)"));
    write(brain, "memory/index.md", catalog(...paths.map(link), link(paths[0])));
    const result = audit(brain, "index.md");
    assert.equal(result.status, "complete");
    assert.equal(result.total, 400);
    assert.equal(result.catalogued, 400);
    assert.equal(result.uncatalogued, 0);
    assert.ok(fs.statSync(path.join(brain, "memory/index.md")).size > 9000);
    assert.ok(fs.statSync(path.join(brain, "memory/SUMMARY.md")).size < 9000);
  });

  test("exact paths: duplicates, nesting, Unicode, spaces and punctuation", () => {
    const brain = fixture("paths");
    const paths = ["core/same.md", "semantic/same.md", "procedural/same.md", "semantic/nested/README.md",
      "semantic/archive/old.md", "semantic/čísla a 部署 (v2)+[a].md", "semantic/literal#?%.md", "core/.hidden.md"];
    for (const file of paths) write(brain, `memory/${file}`, "memory");
    write(brain, "memory/semantic/ignored.txt", "not markdown");
    fs.mkdirSync(path.join(brain, "memory/semantic/directory.md"));
    write(brain, "memory/SUMMARY.md", catalog(...paths.slice(1).map(file => link(file.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F")))));
    const result = audit(brain);
    assert.equal(result.total, paths.length);
    assert.equal(result.catalogued, paths.length - 1);
    assert.deepEqual(result.missingPaths, ["core/same.md"]);
  });

  test("prose, basename, partial names, directory pointers, comments and examples cannot prove coverage", () => {
    const brain = fixture("false-matches");
    for (const file of ["core/topic.md", "semantic/topic.md", "semantic/topic.md.bak.md", "procedural/z.md"]) write(brain, `memory/${file}`, "x");
    write(brain, "memory/SUMMARY.md", "topic.md; core/topic.md\n[incidental](semantic/topic.md)\n" +
      "<!-- ## Memory Catalog\n" + link("procedural/z.md") + " -->\n" +
      "```markdown\n## Memory Catalog\n" + link("core/topic.md") + "\n```\n" +
      catalog(link("semantic/topic.md.bak.md")));
    const result = audit(brain);
    assert.equal(result.status, "warning");
    assert.deepEqual(result.missingPaths, ["core/topic.md", "procedural/z.md", "semantic/topic.md"]);
    write(brain, "memory/SUMMARY.md", catalog("- memory/semantic/ — topics", "- topic.md"));
    assert.equal(audit(brain).status, "incomplete");
    assert.equal(audit(brain).uncatalogued, null);
  });

  test("missing SUMMARY or declared catalog, unsupported format and invalid UTF-8 stay incomplete", () => {
    const brain = fixture("missing");
    for (const text of ["# Legacy prose-only index\n", catalog("- [directory](semantic/)"),
      catalog("- catalog: [Missing](missing.md)"), catalog("- [escape](../../outside.md)"),
      catalog("- [URL](https://example.com/x.md)"), catalog("- [invalid URL encoding](x%ZZ.md)"),
      catalog("- [reference][id]", "[id]: semantic/a.md"),
      "<!-- unclosed comment\n" + catalog(),
      catalog() + catalog(), Buffer.from([0xff])]) {
      write(brain, "memory/SUMMARY.md", text);
      const result = audit(brain);
      assert.equal(result.status, "incomplete", String(text));
      assert.equal(result.uncatalogued, null);
      assert.doesNotMatch(formatAudit(result), /Uncatalogued: 0\//);
    }
    fs.rmSync(path.join(brain, "memory/SUMMARY.md"));
    assert.equal(audit(brain).status, "incomplete");
    assert.equal(runCli(brain).status, 1);
    fs.mkdirSync(path.join(brain, "memory/SUMMARY.md"));
    assert.match(audit(brain).errors.join("\n"), /not a regular file/);
  });

  test("scan failure cannot establish an empty inventory", () => {
    const brain = fixture("scan-error");
    fs.rmdirSync(path.join(brain, "memory/core"));
    const result = audit(brain);
    assert.equal(result.status, "incomplete");
    assert.equal(result.total, null);
    assert.equal(result.uncatalogued, null);
    assert.match(result.errors.join("\n"), /scan core/);
    assert.match(formatAudit(result), /unknown \(incomplete scan\)/);
  });

  if (process.getuid?.() !== 0) test("unreadable catalog and nested inventory directory produce explicit errors", () => {
    const brain = fixture("permissions");
    const summary = path.join(brain, "memory/SUMMARY.md");
    fs.chmodSync(summary, 0);
    try {
      assert.equal(audit(brain).status, "incomplete");
      assert.match(audit(brain).errors.join("\n"), /EACCES/);
    } finally { fs.chmodSync(summary, 0o600); }
    const nested = path.join(brain, "memory/semantic/private");
    fs.mkdirSync(nested);
    fs.chmodSync(nested, 0);
    try {
      assert.equal(audit(brain).total, null);
      assert.equal(audit(brain).uncatalogued, null);
      assert.match(audit(brain).errors.join("\n"), /scan semantic\/private.*EACCES/);
    } finally { fs.chmodSync(nested, 0o700); }
  });

  test("symlinks excluded explicitly; declared catalog symlinks are errors", () => {
    const brain = fixture("symlinks");
    write(brain, "memory/episodic/out.md", "out of scope");
    fs.symlinkSync("../episodic/out.md", path.join(brain, "memory/semantic/symlink.md"));
    fs.symlinkSync("../episodic", path.join(brain, "memory/semantic/linked-dir"));
    assert.equal(audit(brain).total, 0);
    write(brain, "memory/SUMMARY.md", catalog("- catalog: [Page](<semantic/symlink.md>)"));
    assert.equal(audit(brain).status, "incomplete");
  });

  test("CLI is read-only for complete, warning and incomplete results; options fail explicitly", () => {
    const brain = fixture("read-only");
    for (const text of [catalog(), catalog(link("semantic/absent.md")), catalog("unsupported")]) {
      write(brain, "memory/SUMMARY.md", text);
      const before = snapshot(brain);
      const result = runCli(brain);
      assert.match(result.stdout, /^## Memory Catalog Audit\n/);
      assert.deepEqual(snapshot(brain), before);
    }
    write(brain, "memory/semantic/drift.md", "new");
    write(brain, "memory/SUMMARY.md", catalog());
    const before = snapshot(brain);
    assert.match(runCli(brain).stdout, /Status: warning \(discoverability warning\)/);
    assert.deepEqual(snapshot(brain), before);
    for (const args of [["--catalog"], ["--apply"], ["--json", "--json"]]) {
      const result = runCli(brain, ...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /incomplete\/error/);
    }
  });
  console.log(`\n${passed} catalog audit fixture groups passed.`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
