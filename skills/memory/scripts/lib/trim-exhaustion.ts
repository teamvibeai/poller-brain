/** Reporting only. Completed reports count cycles; no state here grants apply. */
import { execFileSync } from "node:child_process";
import { completedReport } from "../../../../scripts/consolidation-retry.mjs";
import { measure, sources, type Mode } from "./mem-condense-core.js";
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"],
}).trimEnd();
export function completedZeroCycles(root: string, mode: Mode, at?: string): number {
  let count = 0;
  try {
    const newest = completedReport(root, at ?? git(root, "rev-parse", "HEAD"));
    const finals = git(root, "log", "--first-parent", "--format=%H %s", newest.final).split("\n")
      .filter(line => /^[a-f0-9]+ chore: consolidate memory \(\d{4}-\d\d-\d\d\)$/.test(line));
    for (const line of finals) {
      const report = completedReport(root, line.split(" ")[0]);
      const records = report.markdown.split("\n").filter((l: string) => l.startsWith("trim-outcome: "))
        .map((l: string) => JSON.parse(l.slice("trim-outcome: ".length))).filter((r: any) => r.source === sources[mode]);
      if (records.length !== 1) break;
      const r = records[0];
      if (r.version !== 1 || ![r.beforeBytes, r.afterBytes, r.threshold].every((n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0) ||
          r.afterBytes < r.beforeBytes || r.afterBytes <= r.threshold || r.outcome !== "heuristic exhausted — condensation review needed") break;
      count++;
    }
  } catch { /* Missing, malformed or unfinished reports establish no further cycles. */ }
  return count;
}
export function printExhaustion(root: string, mode: Mode, text: string, unchangedVerdicts: number,
  pending: number, options: { beforeBytes?: number; completedAt?: string } = {}): void {
  const metrics = measure(mode, text);
  if (!metrics.overCap || pending !== 0) return;
  const beforeBytes = options.beforeBytes ?? metrics.sizeBytes;
  const zero = metrics.sizeBytes >= beforeBytes;
  const consecutiveZeroProgressCycles = zero ? completedZeroCycles(root, mode, options.completedAt) + 1 : 0;
  console.log(`⚠️ ${sources[mode]}: heuristic exhausted — condensation review needed; unchanged-verdicts=${unchangedVerdicts}; consecutive zero-progress cycles=${consecutiveZeroProgressCycles}; ${metrics.sizeBytes}B / threshold ${metrics.threshold}B, overage=${metrics.overage}B. Keep the over-cap warning.`);
  console.log("trim-outcome: " + JSON.stringify({ version: 1, source: sources[mode],
    outcome: "heuristic exhausted — condensation review needed", beforeBytes, afterBytes: metrics.sizeBytes,
    threshold: metrics.threshold, overage: metrics.overage, unchangedVerdicts, consecutiveZeroProgressCycles }));
}
