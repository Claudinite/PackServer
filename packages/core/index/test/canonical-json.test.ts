import { describe, expect, it } from "vitest";
import { canonicalJson, fromBase64Url, toBase64Url } from "../index";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("is independent of insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it("omits undefined members and keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it("refuses values JSON cannot carry rather than signing something else", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
  it("escapes strings as JSON does", () => {
    expect(canonicalJson({ a: 'q"\n ' })).toBe(JSON.stringify({ a: 'q"\n ' }));
  });
});

describe("base64url", () => {
  it("round-trips and has one spelling per byte string", () => {
    const bytes = Uint8Array.from([251, 255, 0, 1]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });
  it("refuses padding, the standard alphabet and non-canonical trailing bits", () => {
    expect(() => fromBase64Url("AAA=")).toThrow();
    expect(() => fromBase64Url("+/+/")).toThrow();
    expect(() => fromBase64Url("AAB")).toThrow();
  });
});

describe("base64url against the platform", () => {
  it("agrees with Buffer for every length from 0 to 40", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255);
      const expected = Buffer.from(bytes).toString("base64url");
      expect(toBase64Url(bytes)).toBe(expected);
      expect(fromBase64Url(expected)).toEqual(bytes);
    }
  });
});
