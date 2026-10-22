import { REQUEST_HEADER_ALLOWLIST, RESPONSE_HEADER_ALLOWLIST } from "@packserver/schema";
import { hmacHex, type HashKey } from "./hash";

export const DATA_CLASSES = ["public", "operational", "personal", "secret", "customer-content"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** Least to most restrictive; where two classes meet, the later one wins. */
const STRICTNESS: Record<DataClass, number> = { public: 0, operational: 1, personal: 2, "customer-content": 3, secret: 4 };
export const stricter = (a: DataClass | undefined, b: DataClass | undefined): DataClass | undefined =>
  a === undefined ? b : b === undefined ? a : STRICTNESS[b] > STRICTNESS[a] ? b : a;

/** A path is dot-joined segments; `*` matches one segment, `**` any number (including none). */
export type ClassRules = Readonly<Record<string, DataClass>>;

const matchSegments = (pattern: readonly string[], path: readonly string[]): boolean => {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") return matchSegments(rest, path) || (path.length > 0 && matchSegments(pattern, path.slice(1)));
  const [first, ...others] = path;
  return first !== undefined && (head === "*" || head === first) && matchSegments(rest, others);
};

/** A rule that names its last segment beats one ending in `**`; then more literal segments win. */
const specificity = (pattern: readonly string[]): number =>
  (pattern[pattern.length - 1] === "**" ? 0 : 1000) + pattern.reduce((n, s) => n + (s === "**" ? 0 : s === "*" ? 1 : 3), 0);

/** The most specific matching rule wins; ties go to the rule listed first. */
export function classOf(rules: ClassRules, path: string): DataClass | undefined {
  const segments = path.split(".");
  let best: { class: DataClass; score: number } | undefined;
  for (const [pattern, cls] of Object.entries(rules)) {
    const parts = pattern.split(".");
    if (!matchSegments(parts, segments)) continue;
    const score = specificity(parts);
    if (!best || score > best.score) best = { class: cls, score };
  }
  return best?.class;
}

/**
 * Rules that hold on every path. Anything no rule reaches is customer-content: a field is
 * never kept in clear because nobody thought to classify it.
 */
export const BASE_RULES: ClassRules = {
  ...Object.fromEntries(REQUEST_HEADER_ALLOWLIST.map((h) => [`request.headers.${h}`, "operational" as const])),
  ...Object.fromEntries(RESPONSE_HEADER_ALLOWLIST.map((h) => [`response.headers.${h}`, "operational" as const])),
  "**.email": "personal",
  "**.ip": "personal",
  "**.password": "secret",
  "**.token": "secret",
  "**.secret": "secret",
  "**.authorization": "secret",
  "**.cookie": "secret",
  "**.set-cookie": "secret",
  "**.api_key": "secret",
  "**.private_key": "secret",
  "**.signature_key": "secret",
  "request.method": "public",
  "request.path_params.scope": "public",
  "request.path_params.pack": "public",
  "request.path_params.version": "public",
  "response.error.name": "operational",
  "response.error.message": "customer-content",
};

/**
 * A rule may deny with `**` (a key name anywhere) but never grant with it: a field nobody named
 * stays unclassified, so it is stored as customer-content and reported.
 */
export function assertNoCatchAllGrant(rules: ClassRules): void {
  for (const [pattern, cls] of Object.entries(rules)) {
    if (pattern.endsWith("**") && (cls === "public" || cls === "operational")) {
      throw new Error(`rule "${pattern}" grants ${cls} to unnamed fields; name each leaf instead`);
    }
  }
}

export interface Redaction {
  value: unknown;
  /** Concrete paths of every value removed or replaced. */
  redactions: string[];
  /** Concrete paths no rule reached; they were treated as customer-content. */
  unclassified: string[];
}

const isContainer = (v: unknown): v is object => v !== null && typeof v === "object";

/** Redacts `value` rooted at `path`; personal and customer-content become keyed-hash placeholders, secrets are dropped. */
export async function redact(
  value: unknown,
  path: string,
  rules: ClassRules,
  key: HashKey,
): Promise<Redaction> {
  const redactions: string[] = [];
  const unclassified: string[] = [];
  const DROPPED = Symbol("dropped");

  const isBytes = (v: unknown): v is Uint8Array | ArrayBuffer => v instanceof Uint8Array || v instanceof ArrayBuffer;

  const placeholder = async (cls: "personal" | "customer-content", v: unknown) => {
    const material = isBytes(v) ? new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : (JSON.stringify(v) ?? "undefined");
    return `<${cls}:${(await hmacHex(key, material)).slice(0, 16)}>`;
  };

  const walk = async (v: unknown, p: string, inherited: DataClass | undefined): Promise<unknown> => {
    if (v === null || v === undefined) return v;
    let cls = stricter(classOf(rules, p), inherited);
    if (isBytes(v)) cls = stricter(cls, "customer-content");
    if (cls === "secret") {
      redactions.push(p);
      return DROPPED;
    }
    if (isContainer(v) && !isBytes(v)) {
      if (Array.isArray(v)) {
        const items = await Promise.all(v.map((item, i) => walk(item, `${p}.${i}`, cls)));
        return items.filter((item) => item !== DROPPED);
      }
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        const r = await walk(child, `${p}.${k}`, cls);
        if (r !== DROPPED) out[k] = r;
      }
      return out;
    }
    if (cls === "personal" || cls === "customer-content") {
      redactions.push(p);
      return placeholder(cls, v);
    }
    if (cls === undefined) {
      unclassified.push(p);
      redactions.push(p);
      return placeholder("customer-content", v);
    }
    return v;
  };

  const out = await walk(value, path, undefined);
  return { value: out === DROPPED ? undefined : out, redactions, unclassified };
}
