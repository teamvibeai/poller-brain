/** Pure plans for consolidation and observe-only provenance (no brain mutations). */
import { MEM_ID_PATTERN } from "./mem-id.js";

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
  const headers = [...today.matchAll(/^# (\d{4}-\d{2}-\d{2})(?:[^\n]*)$/gm)];
  if (today.trim() && (!headers.length || today.slice(0, headers[0].index).trim())) {
    throw new Error("TODAY contains content before its first date header; reconcile before archiving");
  }
  const result = { ...daily };
  for (let i = 0; i < headers.length; i++) {
    const day = headers[i][1];
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

const ENTRY = new RegExp(String.raw`^- \[(?:\d{2}:\d{2}|${MEM_ID_PATTERN}|REMEMBER)\]\[(maint|user)\] `);

function entrySources(text: string): string[] {
  // Metadata is adjacent to the closing identity/timestamp bracket. A space
  // starts legacy content, including literal [user]/[maint] payloads.
  return text.split("\n").filter(line => line.trim() && !line.startsWith("#")).map(line => ENTRY.exec(line)?.[1] ?? "unknown");
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
