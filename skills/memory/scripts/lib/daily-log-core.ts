/** Pure plans for consolidation and observe-only provenance (no brain mutations). */
import { classifyDailyLines } from "../../../../scripts/consolidation-retry.mjs";

function utcDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid UTC date: ${date}`);
  }
  return parsed;
}

export function planTodayArchive(today: string, daily: Record<string, string>, date: string, time: string) {
  utcDate(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Invalid UTC time");
  if (today.trim() && !/^# \d{4}-\d{2}-\d{2}/m.test(today)) {
    today = `# ${date}\n\n${today}`;
  }
  // Do not split opaque payload at an example date header: doing so would
  // discard its Markdown context and turn its following rows into metadata.
  const headers: { day: string; index: number }[] = [];
  let offset = 0;
  for (const row of classifyDailyLines(today)) {
    const header = row.kind === "scaffold" && /^# (\d{4}-\d{2}-\d{2})/.exec(row.line);
    if (header) headers.push({ day: header[1], index: offset });
    offset += row.line.length;
  }
  if (today.trim() && (!headers.length || today.slice(0, headers[0].index).trim())) {
    throw new Error("TODAY contains content before its first date header; reconcile before archiving");
  }
  const result = { ...daily };
  for (let i = 0; i < headers.length; i++) {
    const day = headers[i].day;
    utcDate(day);
    const section = today.slice(i === 0 ? 0 : headers[i].index, headers[i + 1]?.index ?? today.length);
    // Keep every original section byte, including source tags and whitespace.
    result[day] = result[day] ? result[day] + "\n" + section : section;
  }
  return { daily: result, today: `# ${date}\n\n- [${time}][maint] memory consolidation started\n` };
}

export function backfillDailyLog(date: string, subjects: string[]): string {
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][utcDate(date).getUTCDay()];
  return `# ${date} (${day})\n\n` + subjects.map(subject =>
    `- [unknown] (backfilled from git) — ${subject.replace(/[\r\n]+/g, " ")}\n`).join("");
}

function entrySources(text: string): string[] {
  return classifyDailyLines(text).filter(row => row.kind !== "scaffold")
    .map(row => row.source ?? "unknown");
}

export function dailyLogProvenance(input: {
  end: string;
  sessionDays: string[];
  daily: Record<string, string>;
}) {
  const start = utcDate(input.end);
  start.setUTCDate(start.getUTCDate() - 6);
  const first = start.toISOString().slice(0, 10);
  const days = [...new Set(input.sessionDays)].filter(day => day >= first && day <= input.end);
  let logged = 0, user = 0, unknown = 0, complete = 0;
  for (const day of days) {
    const text = input.daily[day] ?? "";
    const sources = entrySources(text);
    const hasLog = text.split("\n").some(line => line.trim() && !line.startsWith("#"));
    if (hasLog) logged++;
    if (sources.includes("user")) user++;
    if (hasLog && (!sources.length || sources.includes("unknown"))) unknown++;
    if (sources.length && !sources.includes("unknown")) complete++;
  }
  const ratio = (n: number) => days.length ? n / days.length : null;
  return {
    version: 1,
    observeOnly: true,
    window: { start: first, end: input.end, timezone: "UTC" },
    basis: "git-commit-days-utc",
    sessionDays: days.length,
    loggedSessionDays: logged,
    userTaggedSessionDays: user,
    unknownSessionDays: unknown,
    fullyTaggedSessionDays: complete,
    coverageRatio: ratio(logged),
    userSessionRatio: ratio(user),
    provenanceCompleteness: ratio(complete),
  };
}
