import { createOrg } from "@packserver/core/scopes";
import { describe, expect, it } from "vitest";
import { WIZARD_CLIENT } from "../src/pages/publish/client";
import { ORIGIN, setup, signUp, wordsOf, type Harness } from "./people";

const NOW = "2026-10-20T10:00:00.000Z";

type Person = Awaited<ReturnType<typeof signUp>>;

/** Records what `web` asks `publish` for and answers like the wizard route does. */
function publishStub(h: Harness, answer: (body: Record<string, unknown>) => Response = () => Response.json({ ok: true })) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  h.runtime.services.publish = {
    fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      return answer(body);
    },
  } as unknown as Fetcher;
  return calls;
}

async function csrfOf(p: Person): Promise<string> {
  return ((await (await p.get("/api/auth/session")).json()) as { csrf: string }).csrf;
}

async function post(h: Harness, p: Person, path: string, body: unknown, extra: Record<string, string> = {}) {
  return h.request(path, {
    method: "POST",
    headers: { cookie: p.cookie, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": await csrfOf(p), "idempotency-key": `wiz-${Math.random().toString(36).slice(2, 12)}`, ...extra },
    body: JSON.stringify(body),
  });
}

const stateOf = (html: string) => JSON.parse(/<script type="application\/json" id="wiz-state">([\s\S]*?)<\/script>/.exec(html)![1]!) as { scopes: string[] } & Record<string, unknown>;

async function seed(h: Harness) {
  const ann = await signUp(h, "ann");
  const org = await createOrg(h.ports, ann.userId, "acme");
  if (!org.ok) throw new Error(org.message);
  return { ann, scope: org.scope };
}

describe("publish wizard page (REQ-PUB-016)", () => {
  it("sends a signed-out visitor to sign in and back, keeping ?pack=", async () => {
    const res = await setup().request("/publish?pack=%40acme%2Fgcp");
    expect([res.status, res.headers.get("location")]).toEqual([303, `/signin?next=${encodeURIComponent("/publish?pack=%40acme%2Fgcp")}`]);
  });

  it("opens on the source step with every step named and the new-pack price struck through", async () => {
    const h = setup();
    const { ann } = await seed(h);
    const html = await (await ann.get("/publish")).text();
    const words = wordsOf(html);
    expect(words).toContain("Publish a pack");
    expect(words.indexOf("Source Check Listing Visibility Publish")).toBeGreaterThan(-1);
    expect(html).toContain("<s>$1 per new pack</s>");
    expect(words).toContain("free through 2026");
    expect(words).not.toMatch(/checkout|card number|Buy\b/i);
    expect(stateOf(html).scopes).toEqual(["ann", "acme"]);
  });

  it("preselects the pack named by ?pack= and offers the draft waiting for it", async () => {
    const h = setup();
    const { ann, scope } = await seed(h);
    await h.d1.query("insert into packs (id, scope_id, name, visibility, created_at) values ('p1', ?, 'gcp', 'public', ?)", [scope.id, NOW]);
    await h.d1.query(
      `insert into upload_credentials (id, secret_hash, source, scope_id, pack_name, version, user_id, staging_key, lifetime, issued_at, expires_at, used_at, uploaded_at, size_bytes, object_expires_at)
       values ('c1', 'h', 'upload', ?, 'gcp', '1.2.0', ?, 'staging/acme/gcp/1.2.0/c1.tar.zst', 'draft', ?, ?, ?, ?, 1234, ?)`,
      [scope.id, ann.userId, NOW, NOW, NOW, NOW, new Date(h.runtime.ports.clock.now() + 86_400_000).toISOString()],
    );
    const html = await (await ann.get(`/publish?pack=${encodeURIComponent("@acme/gcp")}`)).text();
    expect(html).toMatch(/<input[^>]*name="name"[^>]*value="gcp"/);
    expect(html).toMatch(/<option value="acme" selected/);
    expect(stateOf(html)).toMatchObject({ pack: { full: "@acme/gcp", exists: true, visibility: "public" }, draft: { version: "1.2.0", credentialId: "c1", sizeBytes: 1234, expired: false }, lastRun: null });
  });

  it("offers the version of the last failed attempt for a retry, and ignores a pack the person cannot publish to", async () => {
    const h = setup();
    const { ann, scope } = await seed(h);
    await h.d1.query(
      `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, synthetic, status, verdict, start_after, created_at, updated_at)
       values ('r1', 'publish', 'upload', ?, 'gcp', '1.3.0', 'user:x', 'c9', 'k', 'sha', 1, 0, 'finished', 'fail', ?, ?, ?)`,
      [scope.id, NOW, NOW, NOW],
    );
    expect(stateOf(await (await ann.get("/publish?pack=%40acme%2Fgcp")).text()).lastRun).toEqual({ id: "r1", version: "1.3.0", verdict: "fail" });
    const stranger = await signUp(h, "bob");
    expect(stateOf(await (await stranger.get("/publish?pack=%40acme%2Fgcp")).text())).toMatchObject({ pack: null, draft: null, lastRun: null });
  });

  it("lets only this page connect to the staging bucket", async () => {
    const h = setup();
    const { ann } = await seed(h);
    expect((await ann.get("/publish")).headers.get("content-security-policy")).toContain("connect-src 'self' https://*.r2.cloudflarestorage.com;");
    expect((await ann.get("/dashboard")).headers.get("content-security-policy")).toContain("connect-src 'self';");
  });

  it("ships a script that parses", () => {
    expect(() => new Function(WIZARD_CLIENT)).not.toThrow();
    expect(WIZARD_CLIENT).not.toContain("`");
  });
});

describe("publish wizard routes", () => {
  it("asks publish for a credential on the person's behalf, for the pack they typed", async () => {
    const h = setup();
    const { ann } = await seed(h);
    const calls = publishStub(h);
    const res = await post(h, ann, "/publish/wizard/upload", { pack: "@acme/gcp", version: "1.0.0", dry_run: true });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: "http://publish.internal/internal/wizard", body: { principal_id: ann.userId, pack: "@acme/gcp", version: "1.0.0", action: "upload-url", dry_run: true } }]);
  });

  it("refuses a malformed pack, version or hash before asking publish", async () => {
    const h = setup();
    const { ann } = await seed(h);
    const calls = publishStub(h);
    expect((await post(h, ann, "/publish/wizard/upload", { pack: "acme/gcp", version: "1.0.0" })).status).toBe(400);
    expect((await post(h, ann, "/publish/wizard/upload", { pack: "@acme/gcp", version: "latest" })).status).toBe(400);
    expect((await post(h, ann, "/publish/wizard/check", { pack: "@acme/gcp", version: "1.0.0", sha256: "abc", credential_id: "c" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("starts a dry-run for the staged object and passes publish's answer through", async () => {
    const h = setup();
    const { ann } = await seed(h);
    const calls = publishStub(h, () => Response.json({ run_id: "r1" }, { status: 201 }));
    const sha = "a".repeat(64);
    const res = await post(h, ann, "/publish/wizard/check", { pack: "@acme/gcp", version: "1.0.0", sha256: sha, credential_id: "c1" });
    expect([res.status, await res.json()]).toEqual([201, { run_id: "r1" }]);
    expect(calls[0]!.body).toMatchObject({ action: "dry-run", declared_sha256: sha, credential_id: "c1", principal_id: ann.userId });
  });

  it("will not start a publish without a passkey assertion made for that pack and version", async () => {
    const h = setup();
    const { ann } = await seed(h);
    const calls = publishStub(h);
    const res = await post(h, ann, "/publish/wizard/start", { pack: "@acme/gcp", version: "1.0.0", sha256: "a".repeat(64), credential_id: "c1" });
    expect([res.status, ((await res.json()) as { reason: string }).reason]).toEqual([403, "step-up"]);
    expect(calls).toEqual([]);
  });

  it("answers a signed-out caller and a stranger alike for the pack lookup and the run", async () => {
    const h = setup();
    const { scope } = await seed(h);
    await h.d1.query(
      `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, synthetic, status, verdict, start_after, created_at, updated_at)
       values ('r1', 'dry-run', 'upload', ?, 'gcp', '1.0.0', 'user:x', 'c9', 'k', 'sha', 1, 0, 'finished', 'pass', ?, ?, ?)`,
      [scope.id, NOW, NOW, NOW],
    );
    const bob = await signUp(h, "bob");
    expect((await bob.get("/publish/wizard/runs/r1")).status).toBe(404);
    expect((await bob.get("/publish/wizard/pack?name=%40acme%2Fgcp")).status).toBe(404);
    expect((await h.request("/publish/wizard/runs/r1")).status).toBe(401);
  });

  it("shows a member the run's steps, verdict sentence and findings", async () => {
    const h = setup();
    const { ann, scope } = await seed(h);
    await h.d1.query(
      `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, synthetic, status, verdict, start_after, created_at, updated_at)
       values ('r1', 'dry-run', 'upload', ?, 'gcp', '1.0.0', 'user:x', 'c9', 'k', 'sha', 1, 0, 'running', null, ?, ?, ?)`,
      [scope.id, NOW, NOW, NOW],
    );
    await h.d1.query("insert into validation_milestones (run_id, seq, step, outcome, detail, at) values ('r1', 1, 'admission', 'ok', null, ?)", [NOW]);
    const view = (await (await ann.get("/publish/wizard/runs/r1")).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ id: "r1", kind: "dry-run", pack: "@acme/gcp", status: "running", sentence: "Validating. This page updates by itself.", milestones: [{ step: "admission", outcome: "ok" }], findings: [] });
  });
});
