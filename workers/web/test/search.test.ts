import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";

const card = {
  id: "@acme/gcp", pitch: "p", inventory_counts: { rules: 1 }, context_cost: 1, verified: false, verified_domain: null, verified_github_org: null,
  verdict: "pass", repository: null, rating: null, stars: 2, fetches_30d: 3, category: "cloud", score: 80, score_parts: [], newest_eligible: null,
};

function app(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; body: unknown }> = [];
  const mcp = {
    fetch: async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return answer(url, init);
    },
  } as unknown as Fetcher;
  const runtime: WebRuntime = {
    worker: "web", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: { ...createFakePorts({ worker: "web" }), githubLogin: { authorizeUrl: async () => "", profile: async () => { throw new Error("unused"); } } }, services: { mcp, publish: {} as Fetcher }, config: { cdnOrigin: "https://packs.test.invalid", siteOrigins: ["https://registry.test.invalid"] },
  };
  return { app: createApp(runtime), seen };
}

describe("GET /api/search", () => {
  it("hands the query string to the one search in mcp as the same filters", async () => {
    const t = app(() => Response.json({ cards: [card], degraded: false }));
    const res = await t.app.request("/api/search?q=deploy&category=cloud&part=skills&verified=1&has_repository=true&verified_domains=a.test,%20b.test&sort=stars&limit=5&offset=10&engine_version=1.2.3");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cards: [card], degraded: false });
    expect(t.seen).toEqual([
      {
        url: "http://mcp.internal/internal/search",
        body: { query: "deploy", category: "cloud", part: "skills", has_repository: true, verified_only: true, verified_domains: ["a.test", "b.test"], engine_version: "1.2.3", sort: "stars", limit: 5, offset: 10 },
      },
    ]);
  });

  it("treats no query as a browse", async () => {
    const t = app(() => Response.json({ cards: [], degraded: false }));
    await t.app.request("/api/search");
    expect(t.seen[0]?.body).toEqual({});
  });

  it("refuses a request the contract refuses without asking mcp", async () => {
    const t = app(() => Response.json({}));
    for (const path of ["/api/search?sort=newest", "/api/search?limit=500", "/api/search?limit=x"]) expect((await t.app.request(path)).status).toBe(400);
    expect(t.seen).toEqual([]);
  });

  it("passes on mcp's refusal of a category as it was made", async () => {
    const t = app(() => Response.json({ error: "unknown_category", suggestion: "list_categories" }, { status: 400 }));
    const res = await t.app.request("/api/search?category=made-up");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ suggestion: "list_categories" });
  });

  it("is unavailable when mcp is, or answers something other than the contract", async () => {
    for (const answer of [() => new Response("no", { status: 500 }), () => Response.json({ nope: 1 }), () => { throw new Error("down"); }]) {
      const res = await app(answer).app.request("/api/search?q=x");
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("shares an anonymous answer briefly, never a signed-in one nor a degraded one", async () => {
    const ok = app(() => Response.json({ cards: [], degraded: false }));
    expect((await ok.app.request("/api/search?q=x")).headers.get("cache-control")).toContain("public");
    expect((await ok.app.request("/api/search?q=x", { headers: { cookie: "session=1" } })).headers.get("cache-control")).toBe("private, no-store");
    const degraded = app(() => Response.json({ cards: [], degraded: true }));
    expect((await degraded.app.request("/api/search?q=x")).headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("categories and trending", () => {
  it("delegate to mcp", async () => {
    const t = app((url) => Response.json(url.endsWith("categories") ? { categories: [{ category: "cloud", count: 1 }] } : { cards: [card] }));
    expect(await (await t.app.request("/api/categories")).json()).toEqual({ categories: [{ category: "cloud", count: 1 }] });
    expect(await (await t.app.request("/api/trending")).json()).toEqual({ cards: [card] });
    expect(t.seen.map((s) => s.url)).toEqual(["http://mcp.internal/internal/categories", "http://mcp.internal/internal/trending"]);
  });
});
