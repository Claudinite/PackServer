import { utf8 } from "./bytes";

/**
 * RFC 8785 style canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, numbers as
 * ECMAScript serialises them. A key whose value is `undefined` is omitted, as `JSON.stringify` does;
 * anything JSON cannot carry (NaN, Infinity, bigint, functions, symbols) throws rather than being
 * signed as something else.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonical JSON cannot carry a non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(`canonical JSON cannot carry a ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}

export const canonicalBytes = (value: unknown): Uint8Array => utf8(canonicalJson(value));
