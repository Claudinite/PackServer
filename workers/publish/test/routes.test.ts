import { describe, expect, it } from "vitest";
import { createWorld, ZSTD_BYTES, type Body, type TestWorld } from "./harness";

const json = async (res: Response) => (await res.json()) as Body;

function member(world: TestWorld, role = "owner") {
  const user = world.seed.user();
  const scope = world.seed.scope("acme", { members: [[user, role]] });
  return { user, scope };
}

describe("GET /api/publish/runs/<id>", () => {
  it("shows the run to the credential that started it, with its milestones, and to nobody else", async () => {
    const world = createWorld();
    member(world);
    const { res, credential } = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.0" });
    const run = await json(res);
    const seen = await world.get(`/api/publish/runs/${run.run_id}`, credential.secret);
    expect(seen.status).toBe(200);
    expect(await json(seen)).toEqual(run);
    expect(JSON.stringify(run)).not.toContain("staging/");

    const other = await world.publish({ scope: "acme", pack: "other", version: "1.0.0" });
    expect((await world.get(`/api/publish/runs/${run.run_id}`, other.credential.secret)).status).toBe(404);
    expect((await world.get(`/api/publish/runs/${run.run_id}`)).status).toBe(401);
    expect((await world.get(`/api/publish/runs/nope`, credential.secret)).status).toBe(404);
  });

  it("reports a failed run's reason and its failed milestone", async () => {
    const world = createWorld();
    member(world);
    const { res } = await world.publish({ scope: "acme", pack: "gcp", version: "1.0.0", sha256: "e".repeat(64) });
    expect(await json(res)).toMatchObject({
      status: "finished", verdict: "fail", reason: "integrity.sha256_mismatch",
      milestones: [{ step: "admission", outcome: "ok" }, { step: "integrity", outcome: "fail", detail: "integrity.sha256_mismatch" }],
    });
  });
});

describe("POST /api/publish/runs/<id>/approve", () => {
  it("is a stub that says it is not available", async () => {
    const world = createWorld();
    const res = await world.post("/api/publish/runs/r1/approve", {});
    expect(res.status).toBe(501);
  });
});

describe("POST /api/dry-run", () => {
  it("answers an anonymous caller, an unknown credential and the self-test signature as an unknown path", async () => {
    const world = createWorld();
    member(world);
    const unknown = await world.app.request("/api/not-a-route", { method: "POST" });
    const anonymous = await world.post("/api/dry-run", { sha256: "a".repeat(64) });
    const bogus = await world.post("/api/dry-run", { sha256: "a".repeat(64) }, "psu_bogus");
    const selfTest = await world.app.request("/api/dry-run", { method: "POST", headers: { "x-selftest-signature": "abc", "content-type": "application/json" }, body: "{}" });
    for (const res of [anonymous, bogus, selfTest]) {
      expect(res.status).toBe(unknown.status);
      expect(await res.text()).toBe(await unknown.clone().text());
    }
    expect(world.validator.requests).toEqual([]);
  });

  it("validates a staged dry-run object without creating a version, and carries the opt-in to the prose screen", async () => {
    const world = createWorld();
    const { user } = member(world);
    const credential = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0", userId: user, lifetime: "dry-run" });
    expect(credential.stagingKey).toBe(`staging/acme/dry-run/gcp/1.0.0/${credential.id}.tar.zst`);
    const res = await world.post("/api/dry-run", { sha256: credential.sha256, prose_screen: true }, credential.secret);
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ kind: "dry-run", status: "running" });
    expect(world.validator.requests).toEqual([expect.objectContaining({ dry_run: true, staging_key: credential.stagingKey })]);
    expect(world.db.prepare(`select prose_screen from validation_runs`).get()).toEqual({ prose_screen: 1 });
    expect(world.db.prepare(`select count(*) as n from pack_versions`).get()).toEqual({ n: 0 });
    expect(world.db.prepare(`select count(*) as n from packs`).get()).toEqual({ n: 0 });
  });

  it("runs a dry-run at most once per credential and refuses a publish credential", async () => {
    const world = createWorld();
    const { user } = member(world);
    const credential = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0", userId: user, lifetime: "dry-run" });
    const first = await json(await world.post("/api/dry-run", { sha256: credential.sha256 }, credential.secret));
    const replay = await world.post("/api/dry-run", { sha256: credential.sha256 }, credential.secret);
    expect(replay.status).toBe(200);
    expect((await json(replay)).run_id).toBe(first.run_id);
    expect(world.validator.requests).toHaveLength(1);

    const publish = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.1", userId: user });
    expect(await json(await world.post("/api/dry-run", { sha256: publish.sha256 }, publish.secret))).toMatchObject({ reason: "forbidden" });
    const viaOidc = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.2", lifetime: "dry-run" });
    expect(await json(await world.post("/api/dry-run", { sha256: viaOidc.sha256 }, viaOidc.secret))).toMatchObject({ reason: "forbidden" });
  });

  it("refuses a body that is not a hash", async () => {
    const world = createWorld();
    const { user } = member(world);
    const credential = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0", userId: user, lifetime: "dry-run" });
    expect((await world.post("/api/dry-run", { sha256: "short" }, credential.secret)).status).toBe(400);
  });
});

describe("/internal/wizard", () => {
  const ask = (world: TestWorld, body: Record<string, unknown>) => world.post("/internal/wizard", body);

  it("mints an upload credential for an owner or maintainer, and starts the publish for the person's confirmed upload", async () => {
    const world = createWorld();
    const { user } = member(world, "maintainer");
    const minted = await json(await ask(world, { pack: "@acme/gcp", version: "1.0.0", action: "upload-url", principal_id: user }));
    expect(minted).toMatchObject({ ok: true, presign_path: "/api/publish/@acme/gcp/1.0.0/upload-url", credential: expect.stringMatching(/^psu_/) });
    expect(world.db.prepare(`select source, user_id, lifetime from upload_credentials`).get()).toEqual({ source: "upload", user_id: user, lifetime: "draft" });

    const nothingYet = await ask(world, { pack: "@acme/gcp", version: "1.0.0", action: "start", principal_id: user, declared_sha256: "a".repeat(64) });
    expect(nothingYet.status).toBe(409);

    const bytes = ZSTD_BYTES(512);
    const staged = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0", userId: user, bytes });
    const started = await ask(world, { pack: "@acme/gcp", version: "1.0.0", action: "start", principal_id: user, declared_sha256: staged.sha256 });
    expect(started.status).toBe(201);
    const run = await json(started);
    expect(run).toMatchObject({ kind: "publish", status: "running" });

    const seen = await world.get(`/internal/runs/${run.run_id}?principal_id=${user}`);
    expect(await json(seen)).toEqual(run);
    expect((await world.get(`/internal/runs/${run.run_id}?principal_id=somebody-else`)).status).toBe(404);
  });

  it("starts the upload the request names when the person has staged several for one version, and refuses a version a run already holds", async () => {
    const world = createWorld();
    const { user } = member(world);
    const mine = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0", userId: user, bytes: ZSTD_BYTES(512, 1) });
    const later = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0", userId: user, bytes: ZSTD_BYTES(512, 2) });
    const request = { pack: "@acme/gcp", version: "1.0.0", action: "start", principal_id: user };

    const started = await ask(world, { ...request, declared_sha256: mine.sha256, credential_id: mine.id });
    expect(started.status).toBe(201);
    expect(await json(started)).toMatchObject({ status: "running", verdict: null });
    expect(world.db.prepare(`select credential_id from validation_runs`).all()).toEqual([{ credential_id: mine.id }]);

    const replay = await ask(world, { ...request, declared_sha256: mine.sha256, credential_id: mine.id });
    expect(replay.status).toBe(200);
    expect(world.db.prepare(`select count(*) as n from validation_runs`).get()).toEqual({ n: 1 });

    expect(await json(await ask(world, { pack: "@acme/gcp", version: "1.0.0", action: "upload-url", principal_id: user }))).toMatchObject({ reason: "exists" });
    expect(later.id).not.toBe(mine.id);
  });

  it("mints a dry-run credential and starts the dry-run with its own prefix and the opt-in", async () => {
    const world = createWorld();
    const { user } = member(world);
    const minted = await json(await ask(world, { pack: "@acme/gcp", version: "1.0.0", action: "upload-url", principal_id: user, dry_run: true }));
    expect(minted.ok).toBe(true);
    expect(world.db.prepare(`select lifetime, staging_key from upload_credentials`).get()).toMatchObject({ lifetime: "dry-run", staging_key: expect.stringContaining("/dry-run/gcp/1.0.0/") });
    const staged = await world.staged({ scope: "acme", pack: "gcp", version: "1.0.0", userId: user, lifetime: "dry-run" });
    const started = await ask(world, { pack: "@acme/gcp", version: "1.0.0", action: "dry-run", principal_id: user, declared_sha256: staged.sha256, prose_screen: true });
    expect(await json(started)).toMatchObject({ kind: "dry-run", status: "running" });
  });

  it("refuses a version that exists, and a person who is not an owner or maintainer", async () => {
    const world = createWorld();
    const { user, scope } = member(world);
    world.seed.version(world.seed.pack(scope, "gcp"), "1.0.0");
    expect(await json(await ask(world, { pack: "@acme/gcp", version: "1.0.0", action: "upload-url", principal_id: user }))).toMatchObject({ reason: "exists" });

    const stranger = world.seed.user();
    expect(await json(await ask(world, { pack: "@acme/gcp", version: "1.0.1", action: "upload-url", principal_id: stranger }))).toMatchObject({ reason: "forbidden" });
    const reader = world.seed.user();
    world.db.prepare(`insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'viewer', 'x')`).run(scope, reader);
    expect((await ask(world, { pack: "@acme/gcp", version: "1.0.1", action: "upload-url", principal_id: reader })).status).toBe(403);
  });

  it("answers an outsider about a private pack exactly as it answers about a pack that does not exist", async () => {
    const world = createWorld();
    const { scope } = member(world);
    world.seed.pack(scope, "secret", "private");
    const stranger = world.seed.user();
    const request = (pack: string) => ask(world, { pack, version: "1.0.0", action: "upload-url", principal_id: stranger, dry_run: true });
    const privatePack = await request("@acme/secret");
    const missingPack = await request("@acme/missing");
    const missingScope = await request("@nobody/missing");
    expect(privatePack.status).toBe(404);
    expect(await privatePack.text()).toBe(await missingPack.text());
    expect(missingScope.status).toBe(404);
    expect(world.db.prepare(`select count(*) as n from upload_credentials`).get()).toEqual({ n: 0 });
  });

  it("refuses a request that is not one", async () => {
    const world = createWorld();
    expect((await ask(world, { pack: "acme/gcp", version: "1", action: "x" })).status).toBe(400);
  });
});
