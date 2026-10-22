import {
  FLOAT_SIGNIFICANT_DIGITS,
  REQUEST_HEADER_ALLOWLIST,
  RESPONSE_HEADER_ALLOWLIST,
  type VOLATILE_PLACEHOLDERS,
} from "@packserver/schema";

type Placeholder = (typeof VOLATILE_PLACEHOLDERS)[number];
const SIG: Placeholder = "<sig>";
const SESSION: Placeholder = "<session>";
const OPAQUE: Placeholder = "<opaque>";
const ROWID: Placeholder = "<rowid>";
const TS: Placeholder = "<ts>";
const uuidPlaceholder = (n: number): string => ("<uuid:n>" satisfies Placeholder).replace("n", String(n));

const HOUR_MS = 3_600_000;

function canonicalNumber(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (Object.is(n, -0)) return 0;
  return Number.isInteger(n) ? n : Number(n.toPrecision(FLOAT_SIGNIFICANT_DIGITS));
}

/** Sorted keys, NFC strings, `-0` as `0`, floats to six significant digits, `undefined` dropped. */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.normalize("NFC"), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const KEY_PLACEHOLDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(sig|signature|x-signature)$/i, SIG],
  [/^(session|session_id|sid)$/i, SESSION],
  [/^(cursor|nonce|opaque)$/i, OPAQUE],
  [/^(rowid|row_id|last_row_id)$/i, ROWID],
];

/** Replaces volatile values with typed placeholders; one instance per record so `<uuid:n>` numbering is stable within it. */
export class Normalizer {
  private readonly uuids = new Map<string, number>();

  constructor(private readonly nowMs: number) {}

  value(input: unknown, key?: string): unknown {
    if (key !== undefined && input !== null && typeof input !== "object") {
      const hit = KEY_PLACEHOLDERS.find(([re]) => re.test(key));
      if (hit) return hit[1];
    }
    if (typeof input === "string") return this.string(input);
    if (Array.isArray(input)) return input.map((v) => this.value(v));
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = this.value(v, k);
      return out;
    }
    return input;
  }

  private string(s: string): string {
    if (ISO_TS.test(s)) {
      const t = Date.parse(s);
      if (!Number.isNaN(t) && Math.abs(t - this.nowMs) <= HOUR_MS) return TS;
    }
    return s.replace(UUID, (m) => {
      const id = m.toLowerCase();
      let n = this.uuids.get(id);
      if (n === undefined) {
        n = this.uuids.size + 1;
        this.uuids.set(id, n);
      }
      return uuidPlaceholder(n);
    });
  }
}

const KEYWORDS = new Set(
  (
    "select insert into values update set delete from where and or not null is in like between exists join inner left right " +
    "outer cross on as group by order having limit offset union all distinct create table index drop alter add column " +
    "primary key unique references default returning conflict do nothing asc desc case when then else end with replace " +
    "if begin commit rollback pragma"
  ).split(" "),
);
const TABLE_INTRODUCERS = new Set(["from", "join", "into", "update"]);

const SQL_TOKEN = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\s+|[A-Za-z_][A-Za-z0-9_$]*|[\s\S]/g;

export interface NormalizedSql {
  sql: string;
  tables: string[];
  ordered: boolean;
}

/** Whitespace collapsed, comments stripped, keywords lowercased; identifiers, literals and `?` untouched. */
export function normalizeSql(sql: string): NormalizedSql {
  const parts: string[] = [];
  const tables = new Set<string>();
  const words: string[] = [];
  let previousWord = "";
  let ordered = false;
  let lastWasSpace = true;
  const space = () => {
    if (!lastWasSpace) parts.push(" ");
    lastWasSpace = true;
  };
  for (const token of sql.match(SQL_TOKEN) ?? []) {
    if (token.startsWith("--") || token.startsWith("/*") || /^\s+$/.test(token)) {
      space();
      continue;
    }
    lastWasSpace = false;
    if (/^[A-Za-z_]/.test(token)) {
      const lower = token.toLowerCase();
      if (KEYWORDS.has(lower)) {
        parts.push(lower);
        words.push(lower);
        previousWord = lower;
        continue;
      }
      if (TABLE_INTRODUCERS.has(previousWord)) tables.add(token);
      parts.push(token);
      words.push(token);
      previousWord = "";
      continue;
    }
    if ((token.startsWith('"') || token.startsWith("`")) && TABLE_INTRODUCERS.has(previousWord)) {
      tables.add(token.slice(1, -1));
    }
    if (token !== "(" && token !== ".") previousWord = "";
    parts.push(token);
  }
  for (let i = 0; i + 1 < words.length; i++) if (words[i] === "order" && words[i + 1] === "by") ordered = true;
  return { sql: parts.join("").trim(), tables: [...tables].sort(), ordered };
}

export function userAgentFamily(userAgent: string): string {
  const ua = userAgent.trim();
  for (const browser of ["Edg", "Firefox", "Chrome", "Safari"]) {
    if (ua.includes(`${browser}/`)) return browser === "Edg" ? "edge" : browser.toLowerCase();
  }
  return (ua.split(/[\s/]/)[0] ?? "").toLowerCase() || "unknown";
}

function allowlisted<T extends string>(
  headers: Headers | Record<string, string>,
  allowlist: readonly T[],
): Partial<Record<T, string>> {
  const get = (name: string): string | undefined =>
    headers instanceof Headers
      ? (headers.get(name) ?? undefined)
      : Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  const out: Partial<Record<T, string>> = {};
  for (const name of allowlist) {
    const v = get(name);
    if (v !== undefined) out[name] = name === "user-agent" ? userAgentFamily(v) : v;
  }
  return out;
}

export const requestHeaders = (h: Headers | Record<string, string>) => allowlisted(h, REQUEST_HEADER_ALLOWLIST);
/** Query values (an OAuth `code` or `state`) and the fragment never reach a record; the keys stay. */
export function stripLocationQuery(location: string): string {
  const [withQuery = ""] = location.split("#");
  const [path = "", query] = withQuery.split("?");
  if (query === undefined) return path;
  const keys = query.split("&").filter(Boolean).map((kv) => `${kv.split("=")[0]}=`);
  return keys.length ? `${path}?${keys.join("&")}` : path;
}

export function responseHeaders(h: Headers | Record<string, string>) {
  const out = allowlisted(h, RESPONSE_HEADER_ALLOWLIST);
  if (out.location !== undefined) out.location = stripLocationQuery(out.location);
  return out;
}

/** Rows of a query without `ORDER BY` are sorted by canonical JSON so replays compare equal. */
export function sortUnorderedRows(rows: readonly unknown[]): unknown[] {
  return rows.map((r) => [canonicalJson(r), r] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}
