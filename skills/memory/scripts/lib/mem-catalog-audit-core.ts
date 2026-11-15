/** Read-only per-file discoverability audit. Paths in results are memory-relative. */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CatalogAudit {
  status: "complete" | "warning" | "incomplete";
  measuredAt: string;
  indexPaths: string[];
  total: number | null;
  catalogued: number;
  uncatalogued: number | null;
  missingPaths: string[];
  errors: string[];
  cycles: string[];
}

// Deliberately narrow syntax: unsupported catalog lines are errors, not evidence.
function entries(text: string, page: string, errors: string[]) {
  const result: { catalog: boolean; target: string }[] = [];
  let sections = 0;
  let active = false;
  let fence: string | null = null;
  // Comments and fenced examples cannot declare pages or prove coverage.
  const lines = text.replace(/<!--(?:[\s\S]*?-->|[\s\S]*$)/g, comment => {
    if (!comment.endsWith("-->")) errors.push(`${page}: unterminated HTML comment`);
    return comment.replace(/[^\r\n]/g, " ");
  }).split(/\r?\n/);
  lines.forEach((line, i) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (active) errors.push(`${page}:${i + 1}: unsupported fenced catalog entry`);
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length &&
        line.slice(marker[0].length).trim() === "") fence = null;
      return;
    }
    if (fence) return;
    if (line === "## Memory Catalog") {
      sections++;
      active = true;
      return;
    }
    if (/^#{1,2} /.test(line)) active = false;
    if (!active || !line.trim()) return;
    const match = line.match(/^- (catalog: )?\[[^\]\r\n]*\]\((?:<([^<>\r\n]+)>|([^\s()<>]+))\)$/);
    if (!match) errors.push(`${page}:${i + 1}: unsupported catalog entry (use a file link or catalog: link)`);
    else result.push({ catalog: Boolean(match[1]), target: match[2] ?? match[3] });
  });
  if (sections !== 1) errors.push(`${page}: expected exactly one ## Memory Catalog section; found ${sections}`);
  return result;
}

/** Resolve URL-style local link targets against the containing catalog page. */
function normalizeTarget(target: string, page: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("/")) {
    throw new Error("target must be a local relative path");
  }
  // Literal #/? must be percent-encoded when part of a filename.
  const decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]);
  if (!decoded || /[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith("/")) {
    throw new Error("empty, absolute, control-character or backslash target");
  }
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(page), decoded));
  if (relative === ".." || relative.startsWith("../") || !relative.endsWith(".md")) {
    throw new Error("target must be a .md file inside memory/");
  }
  return relative;
}

/** Reject symlink traversal for catalogs, as for the tier inventory. */
function regularFile(memoryRoot: string, relative: string): void {
  let current = memoryRoot;
  const parts = relative.split("/");
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`not a regular ${i === parts.length - 1 ? "file" : "directory"}: ${relative}`);
    }
  }
}

export function auditCatalog(memoryRoot: string, requiredCatalog?: string): CatalogAudit {
  const errors: string[] = [];
  const files = new Set<string>();
  const targets = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycles: string[] = [];
  let scanComplete = true;
  const failure = (where: string, error: unknown) =>
    errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);

  function scan(relative: string): void {
    try {
      const dir = path.join(memoryRoot, relative);
      if (!fs.lstatSync(dir).isDirectory()) throw new Error("not a regular directory");
      for (const name of fs.readdirSync(dir).sort()) {
        const child = `${relative}/${name}`;
        const stat = fs.lstatSync(path.join(memoryRoot, child));
        if (stat.isDirectory()) scan(child);
        else if (stat.isFile() && name.endsWith(".md")) files.add(child);
        // Symlinks and special files are deliberately outside the inventory.
      }
    } catch (error) {
      scanComplete = false;
      failure(`scan ${relative}`, error);
    }
  }

  function visit(page: string): void {
    visited.add(page);
    visiting.add(page);
    try {
      regularFile(memoryRoot, page);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(memoryRoot, page)));
      for (const entry of entries(text, page, errors)) {
        try {
          const target = normalizeTarget(entry.target, page);
          targets.add(target);
          if (entry.catalog && visiting.has(target)) cycles.push(`${page} -> ${target}`);
          else if (entry.catalog && !visited.has(target)) visit(target);
        } catch (error) {
          failure(`${page}: target ${JSON.stringify(entry.target)}`, error);
        }
      }
    } catch (error) {
      failure(`catalog ${page}`, error);
    }
    visiting.delete(page);
  }

  for (const tier of ["core", "semantic", "procedural"]) scan(tier);
  visit("SUMMARY.md");
  if (requiredCatalog !== undefined) {
    try {
      const required = normalizeTarget(requiredCatalog, "SUMMARY.md");
      if (!visited.has(required)) errors.push(`configured catalog ${required} is not declared reachable from SUMMARY.md`);
    } catch (error) {
      failure("configured catalog", error);
    }
  }
  const missingPaths = [...files].filter(file => !targets.has(file)).sort();
  return {
    status: errors.length ? "incomplete" : missingPaths.length ? "warning" : "complete",
    measuredAt: new Date().toISOString(),
    indexPaths: [...visited].sort(),
    total: scanComplete ? files.size : null,
    catalogued: files.size - missingPaths.length,
    uncatalogued: errors.length ? null : missingPaths.length,
    missingPaths,
    errors: errors.sort(),
    cycles: cycles.sort(),
  };
}

export function formatAudit(result: CatalogAudit): string {
  // JSON strings keep unusual paths on one line without changing their identity.
  return [
    "## Memory Catalog Audit",
    `- Status: ${result.status}${result.status === "warning" ? " (discoverability warning)" : ""}`,
    `- Measured at: ${result.measuredAt}`,
    `- Index paths (memory-relative, attempted): ${result.indexPaths.map(p => JSON.stringify(p)).join(", ")}`,
    `- Total tier files: ${result.total ?? "unknown (incomplete scan)"}`,
    `- Catalogued files (observed): ${result.catalogued}`,
    `- Uncatalogued: ${result.uncatalogued === null ? "unknown (incomplete audit)" : `${result.uncatalogued}/${result.total}`}`,
    `- Missing paths${result.status === "incomplete" ? " (observed; not exhaustive)" : ""}:`,
    ...result.missingPaths.map(p => `  - ${JSON.stringify(p)}`),
    ...result.errors.map(error => `- Error: ${JSON.stringify(error)}`),
    ...result.cycles.map(cycle => `- Catalog cycle (visited once): ${JSON.stringify(cycle)}`),
  ].join("\n");
}
