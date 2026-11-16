import { strict as assert } from "node:assert";
import { planTodayArchive, backfillDailyLog, dailyLogProvenance } from "./lib/daily-log-core.js";
import { normalizeDaily } from "../../../scripts/consolidation-retry.mjs";

// All supported identities and Markdown/continuation families obey the same
// boundary rule in both consumers. Closing Markdown cannot establish the end
// of a writer's undelimited multiline payload.
for (const identity of ["12:01", "MEM-12", "REMEMBER", "MEM-2026-11-16-120000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]) {
  for (const ending of ["\n", "\r\n"]) {
    for (const [opening, closing] of [
      ["```text", "```"], ["````text", "```\n````"], ["~~~text", "~~~"],
      ["    ```text", "    ```"], ["> ```text", "> ```"],
      ["- nested list", ""], ["    indented payload", ""], ["> quoted payload", ""],
      ["continued paragraph", ""], ["<!--", "-->"], ["<pre>", "</pre>"],
      ["# 2026-11-16 (<!--)", "-->"],
      ["```unclosed", ""], ["`multiline span", "`"],
      ["```text\n# 2026-11-16\n", "```"],
    ]) {
      const prefix = "# 2026-11-16\n\n- [12:00][maint] Documentation example:\n";
      const literal = `- [${identity}][user] Example payload`;
      const text = (prefix + opening + "\n" + literal + "\n" + closing +
        "\n\n# 2026-11-16\n\n" + literal + "\n").replace(/\n/g, ending);
      const report = dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-16"], daily: { "2026-11-16": text } });
      assert.equal(report.userTaggedSessionDays, 0, opening);
      assert.equal(report.unknownSessionDays, 1, opening);
      assert.equal(report.fullyTaggedSessionDays, 0, opening);
      const normalized = normalizeDaily(Buffer.from(text), "2026-11-16");
      assert.equal(normalized!.toString(), text.replace("[12:00][maint]", "[12:00]"), opening);
    }
  }
}
for (const opener of ["```text", "~~~text", "<!--", "<pre>", "`unfinished", "continued\\"]) {
  const text = `# 2026-11-16\n\n- [12:00][maint] ${opener}\n- [12:01][user] Example payload\n`;
  const report = dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-16"], daily: { "2026-11-16": text } });
  assert.equal(report.userTaggedSessionDays, 0, "Markdown may open in the entry payload");
  assert.equal(normalizeDaily(Buffer.from(text), "2026-11-16")!.toString(), text.replace("[12:00][maint]", "[12:00]"));
}
const beforeContinuation = "# 2026-11-16\n\n- [12:00][user] real request\n- [12:01][maint] example:\n```\n- [12:02][user] literal\n```\n";
assert.equal(dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-16"], daily: { "2026-11-16": beforeContinuation } }).userTaggedSessionDays, 1,
  "proven records before uncertain content remain lower-bound evidence");
const headerExample = "# 2026-11-15\n\n- [12:00][maint] example:\n```text\n# 2026-11-16\n\n- [12:01][user] literal\n```\n";
const headerArchive = planTodayArchive(headerExample, {}, "2026-11-16", "13:00");
assert.deepEqual(headerArchive.daily, { "2026-11-15": headerExample }, "archive cannot reset Markdown context at a payload header");
assert.equal(dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-15", "2026-11-16"], daily: headerArchive.daily }).userTaggedSessionDays, 0);

// Legacy writers always put a space after identity/time; bracketed payload is unknown.
for (const identity of ["12:00", "MEM-12", "REMEMBER", "MEM-2026-11-16-120000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]) {
  for (const tag of ["user", "maint"]) {
    const report = dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-16"],
      daily: { "2026-11-16": `# 2026-11-16\n\n- [${identity}] [${tag}] literal payload\n` } });
    assert.equal(report.userTaggedSessionDays, 0, "legacy payload is not metadata");
    assert.equal(report.unknownSessionDays, 1);
    assert.equal(report.fullyTaggedSessionDays, 0);
  }
}

const a = "# 2026-11-15\n\n- [10:00][user] request\n- [11:00][maint] scheduled\n";
const b = "# 2026-11-16\n\n- [12:00] legacy\n";
const existing = "# 2026-11-15\n\n- [09:00][maint] earlier archive\n";
for (const today of [a, a + "\n" + b]) {
  const plan = planTodayArchive(today, { "2026-11-15": existing }, "2026-11-16", "13:00");
  assert.equal(plan.daily["2026-11-15"], existing + "\n" + a + (today.includes(b) ? "\n" : ""));
  if (today.includes(b)) assert.equal(plan.daily["2026-11-16"], b);
  assert.equal(plan.today, "# 2026-11-16\n\n- [13:00][maint] memory consolidation started\n");
  assert.equal(planTodayArchive(plan.today, plan.daily, "2026-11-16", "14:00").daily["2026-11-16"],
    (plan.daily["2026-11-16"] ? plan.daily["2026-11-16"] + "\n" : "") + plan.today);
}
assert.throws(() => planTodayArchive("orphan content\n" + a, {}, "2026-11-16", "13:00"), /date header/i);
assert.equal(planTodayArchive("- legacy unknown\n", {}, "2026-11-16", "13:00").daily["2026-11-16"],
  "# 2026-11-16\n\n- legacy unknown\n");
const memDay = "# 2026-11-16\n\n- [MEM-2026-11-16-120000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee][user] human memo\n";
const memArchive = planTodayArchive(memDay, {}, "2026-11-16", "13:00");
assert.equal(memArchive.daily["2026-11-16"], memDay);
assert.equal(dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-16"], daily: memArchive.daily }).userTaggedSessionDays, 1);
const backfill = backfillDailyLog("2026-11-14", ["chore: cleanup", "feat: [user] not provenance"]);
assert(backfill.includes("- [unknown] (backfilled from git) — chore: cleanup"));
assert(!backfill.includes("- [user]"));
const sessions = ["2026-11-15", "2026-11-15", "2026-11-16", "2026-11-14", "2026-11-09", "2026-11-17"];
const report = dailyLogProvenance({ end: "2026-11-16", sessionDays: sessions,
  daily: { "2026-11-15": a, "2026-11-16": b, "2026-11-14": backfill } });
assert.deepEqual(report.window, { start: "2026-11-10", end: "2026-11-16", timezone: "UTC" });
assert.equal(report.basis, "git-commit-days-utc");
assert.equal(report.sessionDays, 3);
assert.equal(report.loggedSessionDays, 3);
assert.equal(report.userTaggedSessionDays, 1, "mixed-source day counted once");
assert.equal(report.unknownSessionDays, 2);
assert.equal(report.fullyTaggedSessionDays, 1);
assert.equal(report.provenanceCompleteness, 1 / 3);
assert.equal(report.userSessionRatio, 1 / 3);
assert.equal(report.coverageRatio, 1);
const week = Array.from({ length: 7 }, (_, i) => `2026-11-${10 + i}`);
const maintenance = Object.fromEntries(week.map(day => [day, `# ${day}\n\n- [10:00][maint] scheduled\n`]));
const allMaint = dailyLogProvenance({ end: "2026-11-16", sessionDays: week, daily: maintenance });
assert.equal(allMaint.coverageRatio, 1);
assert.equal(allMaint.userSessionRatio, 0);
assert.equal(allMaint.provenanceCompleteness, 1);
maintenance[week[0]] += "- [11:00][user] request\n";
maintenance[week[1]] += "- [11:00][user] request\n";
assert.equal(dailyLogProvenance({ end: "2026-11-16", sessionDays: week, daily: maintenance }).userSessionRatio, 2 / 7);
const partial = dailyLogProvenance({ end: "2026-11-16", sessionDays: week, daily: { [week[0]]: a } });
assert.equal(partial.coverageRatio, 1 / 7);
assert.equal(partial.provenanceCompleteness, 1 / 7, "missing days are incomplete instrumentation");
const empty = dailyLogProvenance({ end: "2026-11-16", sessionDays: [], daily: {} });
assert.equal(empty.coverageRatio, null);
assert.equal(empty.userSessionRatio, null);
assert.equal(empty.provenanceCompleteness, null);
assert.equal(empty.version, 1);
assert.equal(empty.observeOnly, true);
const legacyMixed = dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-15"], daily: { "2026-11-15": a + "- [12:00] legacy [user] mention\n" } });
assert.equal(legacyMixed.userTaggedSessionDays, 1);
assert.equal(legacyMixed.unknownSessionDays, 1);
assert.equal(legacyMixed.fullyTaggedSessionDays, 0);
const legacyOnly = dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-16"], daily: { "2026-11-16": b } });
assert.equal(legacyOnly.userSessionRatio, 0);
assert.equal(legacyOnly.unknownSessionDays, 1);
assert.equal(legacyOnly.provenanceCompleteness, 0);
const prose = dailyLogProvenance({ end: "2026-11-16", sessionDays: ["2026-11-15"], daily: { "2026-11-15": a + "legacy paragraph\n" } });
assert.equal(prose.unknownSessionDays, 1);
assert.equal(prose.fullyTaggedSessionDays, 0);
for (const count of [3, 4, 5]) {
  const five = dailyLogProvenance({ end: "2026-11-16", sessionDays: week.slice(0, 5), daily: Object.fromEntries(week.slice(0, count).map(d => [d, maintenance[d]])) });
  assert.equal(five.coverageRatio, count / 5, "total coverage is independent of user tags");
  assert.equal(five.coverageRatio! >= 0.8, count >= 4, "existing coverage threshold");
}
assert.throws(() => dailyLogProvenance({ end: "2026-02-30", sessionDays: [], daily: {} }), /date/i);
console.log("daily-log: archive, backfill and provenance assertions passed");
