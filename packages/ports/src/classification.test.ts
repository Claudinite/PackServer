import { describe, expect, it } from "vitest";
import { BASE_RULES, classOf, redact } from "./classification";

describe("classOf", () => {
  it("lets a named final segment beat a trailing wildcard, and a longer literal path beat a shorter", () => {
    const rules = { "a.**": "operational", "**.email": "personal", "a.b.email": "public" } as const;
    expect(classOf(rules, "a.b.email")).toBe("public");
    expect(classOf(rules, "a.c.email")).toBe("personal");
    expect(classOf(rules, "a.c.name")).toBe("operational");
    expect(classOf(rules, "z.name")).toBeUndefined();
  });
});

describe("redact", () => {
  const key = "redaction-key";

  it("hashes personal and customer-content values, drops secrets and keeps public ones", async () => {
    const r = await redact(
      { email: "a@b.example", token: "tok", note: "hello", method: "GET" },
      "request.body",
      { ...BASE_RULES, "request.body.method": "public" },
      key,
    );
    const v = r.value as Record<string, string>;
    expect(v.email).toMatch(/^<personal:[0-9a-f]{16}>$/);
    expect(v.note).toMatch(/^<customer-content:[0-9a-f]{16}>$/);
    expect(v).not.toHaveProperty("token");
    expect(v.method).toBe("GET");
    expect(JSON.stringify(v)).not.toMatch(/a@b|tok|hello/);
    expect(r.redactions.sort()).toEqual(["request.body.email", "request.body.note", "request.body.token"]);
    expect(r.unclassified).toEqual(["request.body.note"]);
  });

  it("treats an unclassified field as customer-content and reports it", async () => {
    const r = await redact({ mystery: 7 }, "x", {}, key);
    expect(r.value).toEqual({ mystery: expect.stringMatching(/^<customer-content:/) });
    expect(r.unclassified).toEqual(["x.mystery"]);
  });

  it("gives equal values equal placeholders and different keys different placeholders", async () => {
    const a = await redact({ n: "v" }, "p", {}, "k1");
    const b = await redact({ n: "v" }, "p", {}, "k1");
    const c = await redact({ n: "v" }, "p", {}, "k2");
    expect(a.value).toEqual(b.value);
    expect(a.value).not.toEqual(c.value);
  });

  it("applies a sensitive rule on a container to every value inside it and keeps the shape", async () => {
    const r = await redact({ rows: [{ a: 1 }, { a: 2 }] }, "r", { r: "operational", "r.rows": "customer-content" }, "k");
    const rows = (r.value as { rows: Array<{ a: string }> }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.a).toMatch(/^<customer-content:/);
    expect(JSON.stringify(r.value)).not.toMatch(/:1\b|:2\b/);
  });

  it("lets a secret key win inside an operational subtree", async () => {
    const r = await redact({ n: 1, token: "t" }, "r", { "r.**": "operational", ...BASE_RULES }, "k");
    expect(r.value).toEqual({ n: 1 });
  });
});
