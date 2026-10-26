import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@packserver/ports/cloudflare";
import { applyIndex, type Listing } from "@packserver/core/search";
import { SqliteD1 } from "@packserver/core/audit/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { McpRuntime } from "../src/bindings";

const config = { embeddingModel: "fake-embedder", embeddingDimensions: 16 };

async function build(search = config) {
  const fakes = createFakePorts({ worker: "mcp" });
  const d1 = new SqliteD1();
  const runtime: McpRuntime = {
    worker: "mcp", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: { ...fakes, d1 }, services: {}, config: { search, cdnOrigin: "https://packs.test.invalid" }, tokenClock: fakes.clock,
  };
  await d1.query("INSERT INTO scopes (id, name, kind, state, created_at) VALUES ('s', 'acme', 'org', 'active', 'x')");
  await d1.query("INSERT INTO packs (id, scope_id, name, visibility, created_at) VALUES ('p', 's', 'gcp', 'public', 'x')");
  await d1.query("INSERT INTO pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified, score) VALUES ('v', 'p', '1.0.0', 'active', 'h', 1, 'x', 0, 0, 80)");
  const listing: Listing = {
    packId: "p", name: "@acme/gcp", scopeKind: "org", pitch: "Deploy to Google Cloud", category: "cloud", tags: [], skills: [],
    stored: { inventory_counts: { rules: 1 }, context_cost: 1, verdict: "pass", repository: null, score_parts: [] }, hasRepository: false,
    promotedAt: "2026-10-01T00:00:00.000Z", newest: { version: "1.0.0", publishedAt: "2026-10-01T00:00:00.000Z", minEngineVersion: null },
    verification: { verified: false, domain: null, githubOrg: null }, score: 80, stars: 0, rating: null,
  };
  await applyIndex({ d1, embedder: fakes.embedder, vectors: fakes.vectors }, listing, "2026-10-01T00:00:00.000Z");
  return createApp(runtime);
}

const post = (app: Awaited<ReturnType<typeof build>>, body: unknown) =>
  app.request("/internal/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the search RPC", () => {
  it("answers a search and a browse with the contract's shape", async () => {
    const app = await build();
    for (const body of [{ query: "google" }, {}]) {
      const res = await post(app, body);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ degraded: false, cards: [{ id: "@acme/gcp", category: "cloud", score: 80, stars: 0 }] });
    }
  });

  it("refuses a request that breaks the contract, and names list_categories for an unknown category", async () => {
    const app = await build();
    expect((await post(app, { limit: 500 })).status).toBe(400);
    expect((await post(app, "not an object")).status).toBe(400);
    const res = await post(app, { category: "made-up" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_category", suggestion: "list_categories" });
  });

  it("is unavailable, not wrong, when it is configured for a model it does not have", async () => {
    const app = await build({ embeddingModel: "other", embeddingDimensions: 16 });
    const res = await post(app, { query: "google" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "misconfigured" });
  });

  it("lists categories and trending", async () => {
    const app = await build();
    const categories = (await (await app.request("/internal/categories")).json()) as { categories: Array<{ category: string; count: number }> };
    expect(categories.categories.find((c) => c.category === "cloud")?.count).toBe(1);
    expect(await (await app.request("/internal/trending")).json()).toEqual({ cards: [] });
  });
});

describe("the embedding configuration", () => {
  it("names, in every environment, the model the port and the Vectorize index were made for", () => {
    const text = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as { env: Record<string, { vars: Record<string, string> }> };
    for (const env of Object.values(config.env)) {
      expect(env.vars.EMBEDDING_MODEL).toBe(EMBEDDING_MODEL);
      expect(env.vars.EMBEDDING_DIMENSIONS).toBe(String(EMBEDDING_DIMENSIONS));
    }
  });
});
