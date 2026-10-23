import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCloudflare } from "./fake-cloudflare.mjs";
import { TOKEN_SPECS, main } from "./provision.mjs";
import { EXTRAS, planResources, readTrustTable } from "./lib/plan.mjs";

const ENV = { CF_BOOTSTRAP_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" };

async function run(argv, cf, extra = {}) {
  const out = [];
  const err = [];
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  const resourcesPath = join(dir, "resources.json");
  const code = await main(argv, ENV, { fetch: cf?.fetch, out: (s) => out.push(s), err: (s) => err.push(s), resourcesPath, ...extra });
  let file;
  try {
    file = JSON.parse(readFileSync(resourcesPath, "utf8"));
  } catch {
    file = undefined;
  }
  return { code, out: out.join("\n"), err: err.join("\n"), file };
}

describe("the plan", () => {
  it("covers every resource the trust table names, per environment", () => {
    const trust = readTrustTable().workers;
    for (const env of ["staging", "production"]) {
      const plan = planResources(env);
      const sfx = (n) => (env === "staging" ? `${n}-staging` : n);
      for (const w of Object.values(trust)) {
        for (const n of Object.values(w.d1)) expect(plan.d1).toContain(sfx(n));
        for (const n of Object.values(w.kv)) expect(plan.kv).toContain(sfx(n));
        for (const v of Object.values(w.r2)) expect(plan.r2).toContain(sfx(v.bucket));
        for (const n of Object.values(w.queues)) expect(plan.queues).toContain(sfx(n));
        for (const n of Object.values(w.vectorize)) expect(plan.vectorize).toContain(sfx(n));
      }
    }
  });

  it("includes the audit dead-letter queue, the extras, and no shadow-records bucket", () => {
    const p = planResources("production");
    expect(p.queues).toEqual(["audit", "audit-dlq", "notify", "reindex"]);
    expect(p.kv).toEqual(["cache", "gates", "oauth", "sessions"]);
    expect(p.r2).toEqual(["audit-log", "ops", "packs-private", "packs-public", "packs-staging", "validation-reports"]);
    expect(p.r2.join()).not.toContain("shadow-records");
    expect(planResources("staging").queues).toContain("audit-dlq-staging");
  });

  it("keeps the extras out of the Worker bindings (they exist only here)", () => {
    const p = planResources("production");
    const trust = readTrustTable().workers;
    const bound = new Set(Object.values(trust).flatMap((w) => [...Object.values(w.queues), ...Object.values(w.r2).map((v) => v.bucket)]));
    for (const n of [...EXTRAS.r2, ...EXTRAS.queues]) {
      expect(bound.has(n)).toBe(false);
      expect([...p.r2, ...p.queues]).toContain(n);
    }
  });
});

describe("dry run", () => {
  it("lists everything and makes no network call", async () => {
    const r = await run(["--env", "production", "--dry-run"], undefined, { fetch: () => { throw new Error("network"); } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/d1 +registry \(location hint enam\)/);
    expect(r.out).toMatch(/vectorize +packs \(1024 dims/);
    expect(r.out).toContain("audit-dlq");
    expect(r.out).toContain("packs.claudinite.com -> packs-public");
    expect(r.file).toBeUndefined();
  });
  it("needs --env", async () => {
    expect((await run(["--dry-run"])).code).toBe(2);
  });
});

describe("provisioning", () => {
  it("creates everything on an empty account and writes ids", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "staging", "--print-ops-token"], cf);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.file.d1["registry-staging"].id).toMatch(/^d1-/);
    expect(Object.keys(r.file.kv)).toEqual(["cache-staging", "gates-staging", "oauth-staging", "sessions-staging"]);
    expect(r.file.secrets_store_id).toMatch(/^store-/);
    expect(r.file.vectorize["packs-staging"].dimensions).toBe(1024);
    expect(r.file.queues["audit-dlq-staging"].id).toMatch(/^queue-/);
    expect(r.file.turnstile.sitekey).toMatch(/^site-/);
    expect(cf.state.d1[0].hint).toBe("enam");
    expect(cf.state.domains["packs-public-staging"]).toEqual(["packs-staging.claudinite.com"]);
    expect(cf.state.dns.map((d) => d.name)).toContain("registry-admin-staging.claudinite.com");
    expect(cf.state.dns.every((d) => d.proxied)).toBe(true);
    expect(Object.values(cf.state.managed).every((v) => v === false)).toBe(true);
    expect(cf.state.secrets).toContain("turnstile-secret-staging");
  });

  it("uses the location hint it is given", async () => {
    const cf = fakeCloudflare();
    await run(["--env", "production", "--d1-location-hint", "weur"], cf);
    expect(cf.state.d1[0].hint).toBe("weur");
  });

  it("is idempotent: a second run creates nothing", async () => {
    const cf = fakeCloudflare();
    const first = await run(["--env", "production", "--print-ops-token"], cf);
    expect(first.code).toBe(0);
    const before = cf.creates().length;
    const second = await run(["--env", "production", "--print-ops-token"], cf);
    expect(second.code).toBe(0);
    expect(cf.creates().length).toBe(before);
    expect(second.file.d1.registry.id).toBe(first.file.d1.registry.id);
  });

  it("never creates from an answer it could not read", async () => {
    for (const [fail, pattern] of [
      ["d1", "/d1/database"],
      ["kv", "/kv/namespaces"],
      ["r2", "/r2/buckets"],
      ["vectorize", "/vectorize/"],
      ["queues", "/queues"],
      ["turnstile", "/challenges/widgets"],
      ["dns", "/dns_records"],
      ["secrets store", "/secrets_store/stores"],
    ]) {
      const cf = fakeCloudflare({ failGet: [pattern] });
      const r = await run(["--env", "production"], cf);
      expect(r.code, fail).toBe(1);
      expect(r.err, fail).toContain("not provisioned");
      const kindPosts = cf.creates().filter((c) => c.path.includes(pattern) && c.method === "POST" && !c.path.includes("/secrets"));
      expect(kindPosts, fail).toEqual([]);
    }
  });

  it("does not take a 403 on the listing for an empty listing", async () => {
    const cf = fakeCloudflare({ failGet: [/d1\/database/] });
    cf.state.d1.push({ uuid: "existing", name: "registry" });
    const r = await run(["--env", "production"], cf);
    expect(r.code).toBe(1);
    expect(cf.creates().some((c) => c.path.endsWith("/d1/database"))).toBe(false);
  });

  it("refuses a listing it cannot prove complete", async () => {
    const cf = fakeCloudflare({ pageSize: 100 });
    cf.state.queues.push(...Array.from({ length: 100 }, (_, i) => ({ queue_id: `q${i}`, queue_name: `other-${i}` })));
    const original = cf.fetch;
    const noInfo = async (url, init) => {
      const res = await original(url, init);
      if (new URL(url).pathname.endsWith("/queues") && (init?.method ?? "GET") === "GET") {
        const body = await res.json();
        delete body.result_info;
        return { ok: true, status: 200, json: async () => body };
      }
      return res;
    };
    const r = await run(["--env", "production"], { ...cf, fetch: noInfo });
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot tell whether");
    expect(cf.creates().some((c) => c.path.endsWith("/queues"))).toBe(false);
  });

  it("treats a create that was applied but not acknowledged as existing", async () => {
    const cf = fakeCloudflare();
    const original = cf.fetch;
    let lost = false;
    const lossy = async (url, init) => {
      const res = await original(url, init);
      if (!lost && init?.method === "POST" && new URL(url).pathname.endsWith("/queues")) {
        lost = true;
        return { ok: false, status: 504, json: async () => ({ success: false, errors: [] }) };
      }
      return res;
    };
    const r = await run(["--env", "production"], { ...cf, fetch: lossy });
    expect(r.code).toBe(0);
    expect(cf.state.queues.filter((q) => q.queue_name === "audit")).toHaveLength(1);
  });

  it("keeps going past one failed resource and reports it", async () => {
    const cf = fakeCloudflare({ failPost: ["/queues"] });
    const r = await run(["--env", "production"], cf);
    expect(r.code).toBe(1);
    expect(r.err).toContain("queue audit");
    expect(r.file.d1.registry.id).toBeDefined();
    expect(r.file.queues).toEqual({});
  });

  it("closes r2.dev access that is open on an existing bucket", async () => {
    const cf = fakeCloudflare({ seed: { r2: ["packs-public"] }, r2DevEnabled: true });
    cf.state.managed["packs-public"] = true;
    await run(["--env", "production"], cf);
    expect(cf.state.managed["packs-public"]).toBe(false);
  });
});

describe("Vectorize dimensions", () => {
  it("refuses an unknown embedding model before any call", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "production", "--embedding-model", "@cf/made/up"], cf);
    expect(r.code).toBe(2);
    expect(r.err).toContain("refusing to guess");
    expect(cf.calls).toEqual([]);
  });

  it("stops on an existing index of another size", async () => {
    const cf = fakeCloudflare({ seed: { vectorize: [{ name: "packs", config: { dimensions: 768 } }] } });
    const r = await run(["--env", "production"], cf);
    expect(r.code).toBe(1);
    expect(r.err).toContain("768");
  });

  it("creates with the model's dimension count and cosine metric", async () => {
    const cf = fakeCloudflare();
    await run(["--env", "production"], cf);
    const post = cf.calls.find((c) => c.method === "POST" && c.path.endsWith("/vectorize/v2/indexes"));
    expect(post.body.config).toEqual({ dimensions: 1024, metric: "cosine" });
  });
});

describe("object tokens", () => {
  it("scopes each to one bucket with item permissions only, never bucket admin", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "production", "--print-ops-token"], cf);
    const posts = cf.calls.filter((c) => c.method === "POST" && c.path.endsWith("/tokens"));
    expect(posts).toHaveLength(TOKEN_SPECS.length);
    const [audit, ops] = posts.map((p) => p.body.policies[0]);
    expect(Object.keys(audit.resources)).toEqual(["com.cloudflare.edge.r2.bucket.acct_default_audit-log"]);
    expect(audit.permission_groups.map((g) => g.id).sort()).toEqual(["pg-read", "pg-write"]);
    expect(Object.keys(ops.resources)).toEqual(["com.cloudflare.edge.r2.bucket.acct_default_ops"]);
    expect(ops.permission_groups.map((g) => g.id)).toEqual(["pg-write"]);
    expect(JSON.stringify(posts)).not.toContain("pg-admin");
    expect(cf.state.secrets).toEqual(expect.arrayContaining(["AUDIT_LOG_S3_ACCESS_KEY_ID", "AUDIT_LOG_S3_SECRET_ACCESS_KEY"]));
    expect(r.out).toMatch(/CN_RELEASES_S3_ACCESS_KEY_ID=tok-/);
    expect(r.out).not.toContain("value-of-");
  });

  it("does not mint the hand-over token unless asked, and never prints the audit-log secret", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "production"], cf);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--print-ops-token");
    expect(r.out).not.toContain("AUDIT_LOG_S3_SECRET_ACCESS_KEY=");
    expect(cf.state.tokens.map((t) => t.name)).toEqual(["packserver-audit-log"]);
  });

  it("revokes a token whose secrets could not be stored", async () => {
    const cf = fakeCloudflare();
    const original = cf.fetch;
    const fetch = async (url, init) => (init?.method === "POST" && /secrets$/.test(new URL(url).pathname) && JSON.parse(init.body)[0].name.startsWith("AUDIT") ? { ok: false, status: 400, json: async () => ({ success: false, errors: [] }) } : original(url, init));
    const r = await run(["--env", "production"], { ...cf, fetch });
    expect(r.code).toBe(1);
    expect(cf.state.tokens).toEqual([]);
  });
});
