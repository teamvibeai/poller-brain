/**
 * Pure --source= flag parsing, shared by log-write.ts and mem-write.ts.
 *
 * Default is "maintenance" (fail-safe direction, poller-brain#169 variant 2):
 * a call that forgets the flag under-reports user-session coverage (visible,
 * self-correcting via the low score) rather than over-reporting it (invisible,
 * defeats the metric's purpose of surfacing brains nobody talks to). Callers
 * must explicitly pass --source=user-session for a genuine human-triggered
 * session (see CLAUDE.md's Message Types section for how to tell).
 *
 * An unrecognized --source= value throws rather than falling through to
 * "rest" — a typo'd flag must fail loudly, not silently become log content.
 */

export type LogSource = "maintenance" | "user-session";

export interface ParsedArgs {
  source: LogSource;
  content: string;
}

const SOURCE_FLAG_PREFIX = "--source=";
const VALID_SOURCES: LogSource[] = ["maintenance", "user-session"];

export function parseSourceFlag(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let source: LogSource = "maintenance";

  for (const arg of argv) {
    if (arg.startsWith(SOURCE_FLAG_PREFIX)) {
      const value = arg.slice(SOURCE_FLAG_PREFIX.length);
      if (!VALID_SOURCES.includes(value as LogSource)) {
        throw new Error(
          `Invalid --source value: "${value}" (expected "maintenance" or "user-session")`
        );
      }
      source = value as LogSource;
    } else {
      rest.push(arg);
    }
  }

  return { source, content: rest.join(" ").trim() };
}

export function sourceTag(source: LogSource): string {
  return source === "maintenance" ? "[maint]" : "[user]";
}
