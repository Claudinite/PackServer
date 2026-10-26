import { migratedD1 } from "@packserver/core/identity/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";
import { approximate, fetchesLine } from "../src/pages/browse/format";

const card = (id: string, over: Record<string, unknown> = {}) => ({
  id, pitch: `Pitch of ${id}`, inventory_counts: { rules: 2, skills: 1 }, context_cost: 1, verified: false, verified_domain: null, verified_github_org: null,
  verdict: "pass", repository: "github.com/acme/x", rating: null, stars: 2, fetches_30d: 10, category: "cloud", score: 80, score_parts: [], newest_eligible: null, ...over,
});

interface Mcp {
  search?: unknown[];
  trending?: unknown[];
  categories?: Array<{ category: string; count: number }>;
  down?: boolean;
}

function site(mcp: Mcp = {}, d1 = migratedD1().d1) {
  const seen: Array<{ url: string; body: unknown }> = [];
  const fetcher = {
    fetch: async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (mcp.down) return new Response("no", { status: 500 });
      if (url.endsWith("/search")) return Response.json({ cards: mcp.search ?? [], degraded: false });
      if (url.endsWith("/trending")) return Response.json({ cards: mcp.trending ?? [] });
      return Response.json({ categories: mcp.categories ?? [] });
    },
  } as unknown as Fetcher;
  const runtime: WebRuntime = {
    worker: "web", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: { ...createFakePorts({ worker: "web" }), d1, githubLogin: { authorizeUrl: async () => "", profile: async () => { throw new Error("unused"); } } },
    services: { mcp: fetcher, publish: {} as Fetcher },
    config: { cdnOrigin: "https://packs.test.invalid", siteOrigins: ["https://registry.test.invalid"] },
  };
  const app = createApp(runtime);
  return { seen, get: async (path: string) => { const res = await app.request(path); return { status: res.status, html: await res.text() }; } };
}

describe("browse (REQ-SEARCH-013, REQ-SEARCH-021, REQ-SCORE-005, REQ-TELEM-003)", () => {
  it("sorts by score when the URL names none", async () => {
    expect((await site().get("/browse")).html).toMatch(/<option value="score" selected/);
  });

  it("hands the URL's state to the one search, with the score sort as the default", async () => {
    const t = site({ search: [] });
    await t.get("/browse?q=deploy&category=cloud&part=skills&verified=1&has_repository=1&verified_domains=acme.test&sort=stars&offset=20");
    await t.get("/browse");
    expect(t.seen.map((s) => s.body)).toEqual([
      { query: "deploy", category: "cloud", part: "skills", has_repository: true, verified_only: true, verified_domains: ["acme.test"], sort: "stars", limit: 20, offset: 20 },
      { limit: 20 },
    ]);
  });

  it("reflects the URL in the form so a copied link reproduces the page", async () => {
    const { html } = await site().get("/browse?q=deploy&category=cloud&verified=1&sort=recent&verified_domains=acme.test");
    expect(html).toContain('value="deploy"');
    expect(html).toMatch(/<option value="cloud" selected/);
    expect(html).toMatch(/name="verified" value="1" checked/);
    expect(html).toMatch(/<option value="recent" selected/);
    expect(html).toMatch(/<details class="more" open/);
  });

  it("shows a card within the budget: mark with its proof, pitch, aggregate fetches, and No public repo only when it applies", async () => {
    const t = site({ search: [card("@acme/a", { verified_domain: "acme.test", fetches_30d: 10 }), card("@kite/b", { repository: null })] });
    const { html } = await t.get("/browse");
    expect(html).toContain('href="/packs/@acme/a"');
    expect(html).toContain(">acme.test<");
    expect(html).toContain(">Unproven<");
    expect(html).toContain("about 10 fetches in 30 days");
    expect(html.match(/No public repo/g)).toHaveLength(1);
    expect(html).not.toContain("Verified Publisher");
  });

  it("says what comes next on no results, and fails the load instead of showing an empty list when search is down", async () => {
    expect((await site().get("/browse?q=zzz")).html).toContain("No packs match.");
    const down = await site({ down: true }).get("/browse");
    expect(down.status).toBe(503);
    expect(down.html).toContain("Search is unavailable");
    expect(down.html).not.toContain("No packs match");
    expect((await site().get("/browse?sort=newest")).status).toBe(400);
  });

  it("offers more only when a full page came back", async () => {
    const full = Array.from({ length: 20 }, (_, i) => card(`@acme/p${i}`));
    expect((await site({ search: full }).get("/browse?q=x")).html).toContain('href="/browse?q=x&amp;offset=20"');
    expect((await site({ search: full.slice(0, 3) }).get("/browse")).html).not.toContain("offset=");
  });
});

describe("home (REQ-COMM-014)", () => {
  const categories = [{ category: "cloud", count: 3 }, { category: "data", count: 0 }];
  it("shows the search box, the categories with packs and Recently published, and no Trending until a pack qualifies", async () => {
    const t = site({ search: [card("@acme/a")], categories });
    const { status, html } = await t.get("/");
    expect(status).toBe(200);
    expect(html).toContain("Claudinite Packs");
    expect(html).toContain("Claude Code only");
    expect(html).toContain('href="/browse?category=cloud"');
    expect(html).not.toContain("category=data");
    expect(html).toContain("Recently published");
    expect(html).not.toContain("Trending");
    expect(html).toContain("/mcp");
    expect(t.seen.find((s) => s.url.endsWith("/search"))?.body).toEqual({ sort: "recent", limit: 5 });
  });

  it("adds the Trending rail once a pack qualifies", async () => {
    const { html } = await site({ search: [card("@acme/a")], trending: [card("@acme/g")], categories }).get("/");
    expect(html).toMatch(/<h2>Trending<\/h2>/);
    expect(html).toContain("@acme/g");
  });

  it("fails the load when the catalogue cannot be read", async () => {
    expect((await site({ down: true }).get("/")).status).toBe(503);
  });
});

describe("profile (REQ-SCOPE-015)", () => {
  const seeded = () => {
    const { d1, db } = migratedD1();
    const at = "2026-10-01T00:00:00.000Z";
    db.exec(`insert into scopes (id, name, kind, state, verified_domain, verified_github_org, created_at) values ('s1', 'acme', 'org', 'active', 'acme.test', 'acme', '${at}'), ('s2', 'plain', 'org', 'active', null, null, '${at}')`);
    for (const [id, scope, name, visibility] of [["p1", "s1", "one", "public"], ["p2", "s1", "two", "public"], ["p3", "s1", "hidden", "private"], ["p4", "s2", "solo", "public"]]) {
      db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('${id}', '${scope}', '${name}', '${visibility}', '${at}')`);
      db.exec(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified, score) values ('v${id}', '${id}', '1.0.0', 'active', '${id}', 1, '${at}', 0, 0, 70)`);
    }
    db.exec(`insert into pack_search (pack_id, name, pitch, category, tags, skills, parts, has_repository, card, updated_at) values ('p4', '@plain/solo', 'Solo pitch', 'other', '', '', 'rules', 0, '{}', '${at}')`);
    db.exec(`insert into users (id, handle, created_at) values ('u1', 'ann', '${at}')`);
    db.exec(`insert into vp_applications (id, scope_id, state, applied_by, applied_at) values ('a1', 's1', 'approved', 'u1', '${at}')`);
    return d1;
  };

  it("shows the proofs, the Verified Publisher label and exactly the public packs", async () => {
    const { status, html } = await site({}, seeded()).get("/@acme");
    expect(status).toBe(200);
    expect(html).toContain(">acme.test<");
    expect(html).toContain("github.com/acme");
    expect(html).toContain("Verified Publisher");
    expect(html).toContain("@acme/one");
    expect(html).toContain("@acme/two");
    expect(html).not.toContain("@acme/hidden");
  });

  it("marks an unproven scope as such and never labels it", async () => {
    const { html } = await site({}, seeded()).get("/@plain");
    expect(html).toContain(">Unproven<");
    expect(html).not.toContain("Verified Publisher");
    expect(html).toContain("Solo pitch");
    expect(html).toContain("No public repo");
  });

  it("answers an unknown scope with the one not-found page, and leaves other single-segment paths to their pages", async () => {
    const t = site({}, seeded());
    const gone = await t.get("/@nobody");
    expect(gone.status).toBe(404);
    expect(gone.html).toContain('href="/signin"');
    expect(gone.html).toContain('name="q"');
    expect((await t.get("/pricing")).status).toBe(200);
  });
});

describe("pricing (REQ-PAY-017)", () => {
  it("strikes every goal price and says free through 2026, with no way to pay", async () => {
    const { html } = await site().get("/pricing");
    for (const price of ["$1 per new pack", "$99 a year", "$7 per seat per month"]) expect(html).toContain(`<s>${price}</s><span class="free">free through 2026</span>`);
    expect(html).toContain("Apply for Verified Publisher");
    expect(html).not.toMatch(/checkout|card number|Buy/i);
  });
});

describe("rules (REQ-VAL-024)", () => {
  it("lists every rule under exactly one class with an anchor, the score parts and caps, and the version", async () => {
    const { html } = await site().get("/rules");
    expect(html).toContain("2026.10.1");
    expect(html).toMatch(/<tr id="archive\.bomb">/);
    const classes = ["Fail", "Hold", "Warn"].map((c) => html.indexOf(`<h2>${c}:`));
    expect(classes.every((i) => i > 0)).toBe(true);
    expect(html).toContain("capped at 70");
    expect(html).toContain("Versions");
  });

  it("filters by the search words", async () => {
    const { html } = await site().get("/rules?q=archive.bomb");
    expect(html).toContain('id="archive.bomb"');
    expect(html).not.toContain('id="manifest.missing"');
  });
});

describe("claude-code and sign-in", () => {
  it("lists all six tools, the sign-in paths, OIDC in CI, the client config and the limits", async () => {
    const { html } = await site().get("/claude-code");
    for (const tool of ["search_packs", "list_categories", "get_pack", "get_download", "list_my_packs", "star_pack"]) expect(html).toContain(`<code>${tool}</code>`);
    expect(html).toContain("https://registry.test.invalid/mcp");
    expect(html).toContain("psr_");
    expect(html).toContain("OIDC");
    expect(html).toContain("claude mcp add");
    expect(html).toContain("600 a minute");
  });

  it("offers GitHub sign-in and carries the return target", async () => {
    const { html } = await site().get("/signin?next=/dashboard");
    expect(html).toContain('action="/api/auth/github"');
    expect(html).toContain('name="next" value="/dashboard"');
  });
});

describe("approximate counts", () => {
  it("round to a size a reader takes as about", () => {
    expect([0, 10, 99, 540, 9300, 9349, 124_400].map(approximate)).toEqual(["0", "10", "99", "540", "9.3k", "9.3k", "124k"]);
    expect(fetchesLine(0)).toBe("No fetches yet");
    expect(fetchesLine(10)).toBe("about 10 fetches in 30 days");
  });
});
