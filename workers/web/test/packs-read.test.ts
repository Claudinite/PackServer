import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";

const SHA = "a".repeat(64);
const GENERATED = "2026-10-22T10:00:00.000Z";
const EXPIRES = "2026-10-29T10:00:00.000Z";
const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const versionRow = (version: string, state = "active") => ({
  version, state, sha256: SHA, upload_sha256: null, size_bytes: 5, published_at: GENERATED, verified: 0, verified_domain: null,
  verified_github_org: null, source_verified: 0, min_engine_version: "1.0.0", requires: "[]", source_commit: null, score: 70, report_key: null,
});

const meta = {
  pack: "@acme/gcp", version: "1.0.0",
  inventory: Object.fromEntries(["skills", "rules", "checks", "guards", "tasks", "env-setup", "forced-skills", "github-actions"].map((p) => [p, { count: 0, names: [], tokens: null }])),
  capabilities: [], preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] }, url_inventory: [],
  score: { total: 70, parts: [], cap: null }, rules_version: "r1",
  verification: { verified: false, verified_domain: null, verified_github_org: null, source_verified: false },
  provenance: { source: "upload", source_verified: false },
  diff_summary: { previous_version: null, files_added: 0, files_removed: 0, files_changed: 0, new_capabilities: [] },
};
const attestation = { pack: "@acme/gcp", version: "1.0.0", upload_sha256: SHA, canonical_sha256: SHA, provenance: meta.provenance, rules_version: "r1", validated_at: GENERATED, kid: "k" };
const history = (status: string) => ({
  kind: "versions", pack: "@acme/gcp", serial: 1, generated_at: GENERATED, expires: EXPIRES, kid: "k", signature: "s",
  versions: [{
    version: "1.0.0", sha256: SHA, size: 5, published_at: GENERATED, status, reason: "why", min_engine_version: "1.0.0", requires: [],
    source_commit: null, preinstall: meta.preinstall, verified: false, verified_domain: null, verified_github_org: null, source_verified: false,
  }],
});

interface World {
  pack?: { id: string; visibility: string };
  rows?: Array<Record<string, unknown>>;
  objects?: Record<string, unknown>;
  hashRows?: Array<Record<string, unknown>>;
  limit?: number;
}

function app(world: World) {
  const fakes = createFakePorts({ worker: "web", rateLimits: { RATE_LIMIT: { limit: world.limit ?? 100, periodMs: 60_000 } } });
  fakes.d1.on(/FROM packs p JOIN scopes/, () => ({ rows: world.pack ? [world.pack] : [] }));
  fakes.d1.on(/FROM pack_versions WHERE pack_id/, () => ({ rows: world.rows ?? [] }));
  fakes.d1.on(/FROM pack_versions pv JOIN packs/, () => ({ rows: world.hashRows ?? [] }));
  for (const [key, value] of Object.entries(world.objects ?? {})) void fakes.r2.PACKS_PUBLIC?.put(key, text(value));
  const runtime: WebRuntime = {
    worker: "web", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: { ...fakes, githubLogin: { authorizeUrl: async () => "", profile: async () => { throw new Error("unused"); } } }, services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { cdnOrigin: "https://packs.test.invalid", siteOrigins: ["https://registry.test.invalid"] },
  };
  return { app: createApp(runtime), fakes };
}

const objects = (status: string) => ({
  "@acme/gcp/1.0.0/meta.json": meta,
  "@acme/gcp/1.0.0/.attestation.json": attestation,
  "@acme/gcp/versions.json": history(status),
});

describe("GET /api/packs", () => {
  it("answers a private pack exactly as it answers one that does not exist", async () => {
    const missing = app({});
    const hidden = app({ pack: { id: "p", visibility: "private" }, rows: [versionRow("1.0.0")], objects: objects("active") });
    for (const path of ["/api/packs/@acme/gcp", "/api/packs/@acme/gcp/1.0.0"]) {
      const a = await missing.app.request(path);
      const b = await hidden.app.request(path);
      expect(b.status).toBe(404);
      expect([b.status, await b.text(), b.headers.get("cache-control")]).toEqual([a.status, await a.text(), a.headers.get("cache-control")]);
    }
  });

  it("never reads a version row for a private pack", async () => {
    const hidden = app({ pack: { id: "p", visibility: "private" }, rows: [versionRow("1.0.0")] });
    await hidden.app.request("/api/packs/@acme/gcp");
    expect(hidden.fakes.d1.executed.some((e) => /FROM pack_versions WHERE pack_id/.test(e.sql))).toBe(false);
  });

  it("serves an active pack with its view and a shareable cache header, private when a cookie rides along", async () => {
    const { app: a } = app({ pack: { id: "p", visibility: "public" }, rows: [versionRow("1.0.0")], objects: objects("active") });
    const res = await a.request("/api/packs/@acme/gcp");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^public, max-age=60/);
    expect(res.headers.get("cache-control")).not.toMatch(/immutable/);
    expect(await res.json()).toMatchObject({ name: "@acme/gcp", latest_eligible: "1.0.0", version: { version: "1.0.0", hashes: { canonical_sha256: SHA } } });
    const signedIn = await a.request("/api/packs/@acme/gcp", { headers: { cookie: "sid=1" } });
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers a quarantined exact version 451 with the reason and no URL, and a removed one 410 with no hash", async () => {
    const held = app({ pack: { id: "p", visibility: "public" }, rows: [versionRow("1.0.0", "quarantined")], objects: objects("quarantined") });
    const res = await held.app.request("/api/packs/@acme/gcp/1.0.0");
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ name: "@acme/gcp", version: "1.0.0", status: "quarantined", under_review: true, reason: "why" });
    const gone = app({ pack: { id: "p", visibility: "public" }, rows: [versionRow("1.0.0", "removed")] });
    const removed = await gone.app.request("/api/packs/@acme/gcp/1.0.0");
    expect(removed.status).toBe(410);
    expect(await removed.text()).not.toContain(SHA);
  });

  it("fails the load rather than show a yanked version without its reason", async () => {
    const { app: a } = app({ pack: { id: "p", visibility: "public" }, rows: [versionRow("1.0.0", "yanked")], objects: { "@acme/gcp/1.0.0/meta.json": meta } });
    expect((await a.request("/api/packs/@acme/gcp/1.0.0")).status).toBe(503);
  });

  it("answers a missing version 404 before it reads the history", async () => {
    const { app: a } = app({ pack: { id: "p", visibility: "public" }, rows: [versionRow("1.0.0", "yanked")] });
    expect((await a.request("/api/packs/@acme/gcp/9.9.9")).status).toBe(404);
  });

  it("leaves a sub-path that is not a version to the routers mounted after it", async () => {
    const { app: a, fakes } = app({});
    expect((await a.request("/api/packs/@acme/gcp/reviews")).status).toBe(404);
    expect(fakes.d1.executed).toEqual([]);
  });

  it("hides unpublished versions", async () => {
    const { app: a } = app({ pack: { id: "p", visibility: "public" }, rows: [versionRow("1.0.0", "pending")] });
    expect((await a.request("/api/packs/@acme/gcp")).status).toBe(404);
  });
});

describe("GET /api/verify", () => {
  it("looks up public packs only and answers a miss like a private hit", async () => {
    const { app: a, fakes } = app({ hashRows: [] });
    const res = await a.request(`/api/verify/${SHA}`);
    expect(await res.json()).toEqual({ result: "unknown" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(fakes.d1.executed[0]?.sql).toContain("p.visibility = 'public'");
  });

  it("names the version a canonical hash belongs to", async () => {
    const { app: a } = app({ hashRows: [{ scope: "acme", pack: "gcp", version: "1.0.0", state: "yanked", sha256: SHA, upload_sha256: "b".repeat(64) }] });
    expect(await (await a.request(`/api/verify/${SHA.toUpperCase()}`)).json()).toEqual({ result: "canonical", pack: "@acme/gcp", version: "1.0.0", status: "yanked" });
  });

  it("refuses what is not a SHA-256 without touching the database", async () => {
    const { app: a, fakes } = app({});
    expect((await a.request("/api/verify/not-a-hash")).status).toBe(400);
    expect(fakes.d1.executed).toEqual([]);
  });

  it("limits a source address after its allowance and counts each address apart", async () => {
    const { app: a } = app({ limit: 3 });
    const ask = (ip: string) => a.request(`/api/verify/${SHA}`, { headers: { "cf-connecting-ip": ip } });
    for (let i = 0; i < 3; i++) expect((await ask("198.51.100.1")).status).toBe(200);
    const limited = await ask("198.51.100.1");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ reason: "rate-limited" });
    expect((await ask("198.51.100.2")).status).toBe(200);
  });
});
