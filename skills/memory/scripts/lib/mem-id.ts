/** Shared syntactic MEM identity grammar. Identity preserves the exact spelling. */
export const LEGACY_MEM_ID_PATTERN = String.raw`MEM-\d+(?!\d|-\d)`;
export const DATED_MEM_ID_PATTERN = String.raw`MEM-\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`;
/** Dated first; legacy cannot backtrack to a numeric prefix of a dated ID. */
export const MEM_ID_PATTERN = `(?:${DATED_MEM_ID_PATTERN}|${LEGACY_MEM_ID_PATTERN})`;
/** Compact suffixes are legacy-only: a dated identity is always one citation. */
export const MEM_CITATION_PATTERN = `(?:${DATED_MEM_ID_PATTERN}|${LEGACY_MEM_ID_PATTERN}(?:[/,]\\d+)*)`;

export type MemId =
  | { kind: "legacy"; n: number }
  | { kind: "dated"; date: string; time: string; uuid: string };

const VALID_RE = new RegExp(`^${MEM_ID_PATTERN}$`);
const DATED_RE = new RegExp(`^(${DATED_MEM_ID_PATTERN})$`);

export function isMemId(value: string): boolean {
  return VALID_RE.exec(value)?.[0] === value;
}

export function parseMemId(value: string): MemId | null {
  if (!isMemId(value)) return null;
  if (!DATED_RE.test(value)) return { kind: "legacy", n: Number(value.slice(4)) };
  return { kind: "dated", date: value.slice(4, 14), time: value.slice(15, 21), uuid: value.slice(22) };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Legacy numeric order, then dated date/time/lowercase UUID; spelling breaks ties. */
export function compareMemIds(a: string, b: string): number {
  const left = parseMemId(a);
  const right = parseMemId(b);
  if (!left && !right) return compareStrings(a, b);
  if (!left || !right) return left ? -1 : 1;
  if (left.kind !== right.kind) return left.kind === "legacy" ? -1 : 1;
  if (left.kind === "legacy" && right.kind === "legacy") {
    const x = BigInt(a.slice(4));
    const y = BigInt(b.slice(4));
    return x < y ? -1 : x > y ? 1 : compareStrings(a, b);
  }
  if (left.kind === "dated" && right.kind === "dated") {
    return compareStrings(left.date, right.date) || compareStrings(left.time, right.time) ||
      compareStrings(left.uuid.toLowerCase(), right.uuid.toLowerCase()) || compareStrings(a, b);
  }
  return 0;
}
