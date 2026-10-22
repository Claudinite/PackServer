import { describe, expect, it } from "vitest";
import { Normalizer, canonicalJson, normalizeSql, requestHeaders, responseHeaders, sortUnorderedRows, userAgentFamily } from "./normalize";

describe("canonicalJson", () => {
  it("sorts keys, folds -0, rounds floats to six digits and applies NFC", () => {
    expect(canonicalJson({ b: 1, a: { d: -0, c: 0.123456789 }, e: "é" })).toBe(
      '{"a":{"c":0.123457,"d":0},"b":1,"e":"é"}',
    );
  });

  it("gives the same text for any key order", () => {
    expect(canonicalJson({ x: 1, y: [{ b: 1, a: 2 }] })).toBe(canonicalJson({ y: [{ a: 2, b: 1 }], x: 1 }));
  });

  it("drops undefined members and turns non-finite numbers into null", () => {
    expect(canonicalJson({ a: undefined, b: Number.NaN })).toBe('{"b":null}');
  });
});

describe("Normalizer", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");

  it("replaces timestamps within an hour of now and keeps distant ones", () => {
    const n = new Normalizer(now);
    expect(n.value({ a: "2026-10-22T12:30:00Z", b: "2026-10-22T14:00:01Z", c: "2026-10-22T11:00:00.000Z" })).toEqual({
      a: "<ts>",
      b: "2026-10-22T14:00:01Z",
      c: "<ts>",
    });
  });

  it("numbers uuids by first appearance across the record", () => {
    const n = new Normalizer(now);
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(n.value({ x: a, y: `/v/${b}`, z: a.toUpperCase() })).toEqual({ x: "<uuid:1>", y: "/v/<uuid:2>", z: "<uuid:1>" });
  });

  it("replaces signature, session, cursor and row id values by key", () => {
    const n = new Normalizer(now);
    expect(n.value({ sig: "abc", session: "s", cursor: "c", last_row_id: 9, keep: "k" })).toEqual({
      sig: "<sig>",
      session: "<session>",
      cursor: "<opaque>",
      last_row_id: "<rowid>",
      keep: "k",
    });
  });
});

describe("normalizeSql", () => {
  it("collapses whitespace, strips comments, lowercases keywords and keeps identifiers, literals and placeholders", () => {
    const n = normalizeSql(`SELECT  Name, 'It''s  X' AS lit -- trailing
      FROM /* c */ Users WHERE id = ?   AND "Odd Col" = ?`);
    expect(n.sql).toBe(`select Name, 'It''s  X' as lit from Users where id = ? and "Odd Col" = ?`);
    expect(n.tables).toEqual(["Users"]);
    expect(n.ordered).toBe(false);
  });

  it("extracts every touched table and detects ORDER BY", () => {
    const n = normalizeSql("select a from t1 join t2 on t1.id = t2.id order by a");
    expect(n.tables).toEqual(["t1", "t2"]);
    expect(n.ordered).toBe(true);
    expect(normalizeSql("INSERT INTO log (a) VALUES (?)").tables).toEqual(["log"]);
    expect(normalizeSql("update users set a = ? where id = ?").tables).toEqual(["users"]);
  });

  it("does not read ORDER BY out of a string literal", () => {
    expect(normalizeSql("select 'order by x' from t").ordered).toBe(false);
  });
});

describe("headers", () => {
  it("keeps only allowlisted request headers, reduces the user agent to its family and never carries credentials", () => {
    const h = requestHeaders({
      Authorization: "Bearer secret",
      Cookie: "s=1",
      "Content-Type": "application/json",
      "User-Agent": "cn/1.4.2 (linux)",
      "Idempotency-Key": "k1",
      "X-Forwarded-For": "198.51.100.7",
    });
    expect(h).toEqual({ "content-type": "application/json", "user-agent": "cn", "idempotency-key": "k1" });
    expect(JSON.stringify(h)).not.toMatch(/secret|198\.51/);
  });

  it("keeps only allowlisted response headers", () => {
    const h = responseHeaders(new Headers({ "Set-Cookie": "a=b", ETag: '"x"', "Retry-After": "5", "X-PackServer-Version": "1" }));
    expect(h).toEqual({ etag: '"x"', "retry-after": "5", "x-packserver-version": "1" });
  });

  it("names browser families", () => {
    expect(userAgentFamily("Mozilla/5.0 Chrome/120.0 Safari/537.36")).toBe("chrome");
    expect(userAgentFamily("")).toBe("unknown");
  });
});

describe("sortUnorderedRows", () => {
  it("orders rows by canonical JSON whatever their arrival order", () => {
    expect(sortUnorderedRows([{ a: 2 }, { a: 1 }])).toEqual(sortUnorderedRows([{ a: 1 }, { a: 2 }]));
  });
});
