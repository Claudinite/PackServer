import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, HSTS, makeNonce, securityHeaders } from "../src/headers";

const app = new Hono();
app.use(securityHeaders());
app.get("/page", (c) => c.html(`<p>${c.get("cspNonce")}</p>`));
app.get("/api/x", (c) => {
  c.header("access-control-allow-origin", "https://evil.example");
  c.header("access-control-allow-credentials", "true");
  return c.json({ ok: true });
});

const directives = (csp: string) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("security headers (IT-ABUSE-008, IT-ABUSE-009)", () => {
  it("serves a CSP with no unsafe-inline or unsafe-eval for script, and a nonce that changes per response", async () => {
    const a = await app.request("/page");
    const b = await app.request("/page");
    const csp = a.headers.get("content-security-policy") ?? "";
    const d = directives(csp);
    expect(d["script-src"]).toEqual([`'nonce-${await nonceOf(a)}'`]);
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    expect(d["default-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(await nonceOf(a)).not.toBe(await nonceOf(b));
  });

  it("refuses framing and sends HSTS of at least a year on every response", async () => {
    for (const path of ["/page", "/api/x", "/missing"]) {
      const res = await app.request(path);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("strict-transport-security") ?? "")?.[1]);
      expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
    }
    expect(HSTS).toContain("includeSubDomains");
  });

  it("lets no foreign origin read a credentialed answer", async () => {
    const res = await app.request("/api/x", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("puts the CSP on HTML only", async () => {
    expect((await app.request("/api/x")).headers.get("content-security-policy")).toBeNull();
  });

  it("builds nonces that are 32 hex digits", () => {
    expect(makeNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(contentSecurityPolicy("abc")).toContain("'nonce-abc'");
  });
});

async function nonceOf(res: Response): Promise<string> {
  return /<p>(.*)<\/p>/.exec(await res.clone().text())?.[1] ?? "";
}
