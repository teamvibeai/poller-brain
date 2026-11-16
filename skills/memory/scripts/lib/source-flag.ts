/** Shared provenance parsing. Missing flags conservatively default to maintenance. */
export type LogSource = "maintenance" | "user-session";

export function parseSourceFlag(argv: string[]): { source: LogSource; content: string } {
  const rest: string[] = [];
  let explicit: LogSource | undefined;
  for (const arg of argv) {
    if (arg === "--source") throw new Error("Use --source=maintenance or --source=user-session");
    if (!arg.startsWith("--source=")) { rest.push(arg); continue; }
    const value = arg.slice("--source=".length);
    if (value !== "maintenance" && value !== "user-session") {
      throw new Error(`Invalid --source value: "${value}" (expected maintenance or user-session)`);
    }
    if (explicit && explicit !== value) throw new Error("Conflicting --source values");
    explicit = value;
  }
  return { source: explicit ?? "maintenance", content: rest.join(" ").trim() };
}

export function sourceTag(source: LogSource): string {
  return source === "maintenance" ? "[maint]" : "[user]";
}
