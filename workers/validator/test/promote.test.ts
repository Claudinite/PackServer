import { privateArchiveKey } from "@packserver/core/access";
import { canonicalise, extractArchive } from "@packserver/core/canonical";
import { fixtureArchive } from "@packserver/core/canonical/fixtures";
import { scoreInputsOf } from "@packserver/core/score";
import { RULES_VERSIONS } from "@packserver/rules";
import { describe, expect, it } from "vitest";
import type { ValidatorRuntime } from "../src/bindings";
import { commit, notify, prepare, reindex, search, writeObjects, type Context } from "../src/promote/promote";
import { runKeys } from "../src/workflow/report";
import { testRuntime } from "./support";

const RULES = RULES_VERSIONS.at(-1)!;
const FINISHED = "2026-10-22T12:05:00.000Z";

interface Seeded {
  rt: ValidatorRuntime;
  ctx: Context;
  db: Awaited<ReturnType<typeof testRuntime>>["db"];
  fakes: Awaited<ReturnType<typeof testRuntime>>["fakes"];
  publicBucket: Awaited<ReturnType<typeof testRuntime>>["publicBucket"];
  privateBucket: Awaited<ReturnType<typeof testRuntime>>["privateBucket"];
  rebuilt: string[];
  canonicalSha256: string;
}

/** A finished, passing run of `@acme/gcp@1.0.0` as the pipeline leaves it, with the coordinator's two methods this step calls. */
async function finishedRun(o: { verdict?: string; widening?: number; visibility?: "public" | "private"; version?: string } = {}): Promise<Seeded> {
  const t = await testRuntime();
  const { rt, db, fakes } = t;
  const version = o.version ?? "1.0.0";
  db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s-acme', 'acme', 'org', 'active', 'x')`);
  const tree = await extractArchive(fixtureArchive("gcp", { version }));
  const canonical = canonicalise(tree);
  const reports = fakes.r2.VALIDATION_REPORTS!;
  const verdict = o.verdict ?? "pass";
  await reports.put(`runs/run1/canonical.tar.zst`, canonical.archive);
  const manifest = { pitch: "Cloud helpers", tags: ["cloud"], category: "cloud", minEngineVersion: "1.61001.1" };
  await reports.put(
    runKeys.sandboxA("run1"),
    new TextEncoder().encode(
      JSON.stringify({
        schema: 1, outcome: "ok", image_digest: null, rules_version: RULES, pack_code_executed: false, refusal: null,
        tree_hash: canonical.treeHash, canonical_sha256: canonical.sha256, canonical_bytes: canonical.archive.byteLength, file_count: tree.files.length, round_trip_ok: true,
        findings: [], findings_total: 0, findings_truncated: false, manifest, urls: [],
        capabilities: { capabilities: [], preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] }, widening: false },
        score_inputs: scoreInputsOf(tree, RULES), inspectors: [], timings_ms: { extract: 1, total: 2 }, error: null,
      }),
    ),
  );
  await reports.put(
    runKeys.report("run1"),
    new TextEncoder().encode(
      JSON.stringify({
        run_id: "run1", pack: "@acme/gcp", version, rules_version: RULES, started_at: "2026-10-22T12:00:00.000Z", finished_at: FINISHED, verdict, steps: [],
        findings: [{ rule: "license.missing", class: "warn", file: null, line: null, hint: "x" }].slice(0, verdict === "warn" ? 1 : 0),
        tree_hash: canonical.treeHash, canonical_sha256: canonical.sha256, source_verified: false, prose_screen: null, score: 80,
      }),
    ),
  );
  db.prepare(
    `insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, status, verdict, start_after,
       report_key, tree_hash, canonical_sha256, canonical_key, source_verified, widening, score, rules_version, finished_at, created_at, updated_at)
     values ('run1', 'publish', 'upload', 's-acme', 'gcp', ?, 'user:u1', 'c1', 'k', ?, 5, 'finished', ?, 'x', ?, ?, ?, 'runs/run1/canonical.tar.zst', 0, ?, 80, ?, ?, 'x', 'x')`,
  ).run(version, "e".repeat(64), verdict, runKeys.report("run1"), canonical.treeHash, canonical.sha256, o.widening ?? 0, RULES, FINISHED);

  const rebuilt: string[] = [];
  fakes.durableObjects.register("ScopeCoordinator", "acme", {
    insertVersion: (request) => {
      const flipped = db.prepare(`update pack_versions set state = 'active', published_at = '2026-10-22T12:06:00.000Z' where state = 'approved' and version = ?`).run(request.version);
      const state = db.prepare(`select state from pack_versions where version = ?`).get(request.version) as { state: string } | undefined;
      return { schema_version: 1, promoted: flipped.changes === 1, already_promoted: flipped.changes !== 1 && state !== undefined && state.state !== "approved" };
    },
    rebuildIndex: (request) => (rebuilt.push(request.scope), { schema_version: 1, sha256: "f".repeat(64), serial: rebuilt.length }),
  });
  if (o.visibility === "private") db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p-pre', 's-acme', 'gcp', 'private', 'x')`);
  return { ...t, ctx: { rt, runId: "run1" }, rebuilt, canonicalSha256: canonical.sha256 };
}

const rowsOf = (db: Seeded["db"], table: string) => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
const snapshot = (bucket: Seeded["publicBucket"]) => [...bucket.objects.entries()].map(([key, o]) => [key, [...o.body].join(","), o.cache_control]).sort();

async function allSteps(s: Seeded) {
  const prepared = await prepare(s.ctx);
  if (!prepared.promote) return prepared;
  await writeObjects(s.ctx, prepared.versionId);
  await commit(s.ctx);
  await reindex(s.ctx);
  await search(s.ctx);
  await notify(s.ctx, prepared.versionId);
  return prepared;
}

describe("promotion", () => {
  it("writes the version's objects, commits it active, rebuilds the scope, indexes it for search and queues one notice", async () => {
    const s = await finishedRun();
    await allSteps(s);
    expect([...s.publicBucket.objects.keys()].sort()).toEqual([
      "@acme/gcp/1.0.0/.attestation.json",
      "@acme/gcp/1.0.0/contents.json",
      "@acme/gcp/1.0.0/meta.json",
      "@acme/gcp/1.0.0/pack.tar.zst",
      "@acme/gcp/1.0.0/pack.tar.zst.sha256",
    ]);
    expect(s.db.prepare(`select state, published_at, verified, sha256 from pack_versions`).all()).toEqual([
      { state: "active", published_at: "2026-10-22T12:06:00.000Z", verified: 0, sha256: s.canonicalSha256 },
    ]);
    expect(s.rebuilt).toEqual(["acme"]);
    expect(rowsOf(s.db, "pack_search")).toBe(1);
    expect(s.fakes.queues.NOTIFY_QUEUE!.messages).toEqual([
      expect.objectContaining({ type: "version.promoted", pack: "@acme/gcp", version: "1.0.0", run_id: "run1" }),
    ]);
    expect(new TextDecoder().decode(s.publicBucket.objects.get("@acme/gcp/1.0.0/pack.tar.zst.sha256")!.body)).toBe(`${s.canonicalSha256}\n`);
  });

  it("is idempotent: running every step again changes no object, adds no version and no search row", async () => {
    const s = await finishedRun();
    await allSteps(s);
    const before = snapshot(s.publicBucket);
    const again = await allSteps(s);
    expect(again.promote).toBe(true);
    expect(snapshot(s.publicBucket)).toEqual(before);
    expect(rowsOf(s.db, "pack_versions")).toBe(1);
    expect(rowsOf(s.db, "packs")).toBe(1);
    expect(rowsOf(s.db, "pack_search")).toBe(1);
    const queued = s.fakes.queues.NOTIFY_QUEUE!.messages as Array<{ dedupe: string }>;
    expect(new Set(queued.map((m) => m.dedupe)).size).toBe(1);
  });

  it("does not repeat a write: a second pass over the objects writes nothing", async () => {
    const s = await finishedRun();
    const prepared = await prepare(s.ctx);
    if (!prepared.promote) throw new Error("not promotable");
    expect((await writeObjects(s.ctx, prepared.versionId)).written).toHaveLength(5);
    expect((await writeObjects(s.ctx, prepared.versionId)).written).toEqual([]);
  });

  it("holds no version before the commit: a crash after the puts leaves the row approved, and the resumed run commits it exactly once", async () => {
    const s = await finishedRun();
    const prepared = await prepare(s.ctx);
    if (!prepared.promote) throw new Error("not promotable");
    await writeObjects(s.ctx, prepared.versionId);
    expect(s.db.prepare(`select state, published_at from pack_versions`).all()).toEqual([{ state: "approved", published_at: null }]);
    expect(s.rebuilt).toEqual([]);

    await allSteps(s);
    expect(s.db.prepare(`select state from pack_versions`).all()).toEqual([{ state: "active" }]);
    expect((await commit(s.ctx)).alreadyPromoted).toBe(true);
  });

  it("counts as promoted from the commit: a crash before the index rebuild converges on resume without a second notice", async () => {
    const s = await finishedRun();
    const prepared = await prepare(s.ctx);
    if (!prepared.promote) throw new Error("not promotable");
    await writeObjects(s.ctx, prepared.versionId);
    expect((await commit(s.ctx)).promoted).toBe(true);
    expect(s.rebuilt).toEqual([]);
    expect(s.fakes.queues.NOTIFY_QUEUE!.messages).toEqual([]);

    await allSteps(s);
    expect(s.rebuilt).toEqual(["acme"]);
    expect(rowsOf(s.db, "pack_versions")).toBe(1);
    expect(s.fakes.queues.NOTIFY_QUEUE!.messages).toHaveLength(1);
    expect(rowsOf(s.db, "pack_search")).toBe(1);
  });

  it("does not promote a failed run, a run that widens what the pack may do, or one that is not a publish", async () => {
    for (const o of [{ verdict: "fail" }, { widening: 1 }, { verdict: "hold" }]) {
      const s = await finishedRun(o);
      expect(await prepare(s.ctx)).toEqual({ promote: false });
      expect(rowsOf(s.db, "pack_versions")).toBe(0);
      expect(s.publicBucket.objects.size).toBe(0);
    }
  });

  describe("a version the registry stages instead of promoting", () => {
    const leftStaged = async (s: Seeded) => {
      const before = rowsOf(s.db, "pack_versions");
      expect(await prepare(s.ctx)).toEqual({ promote: false });
      expect(rowsOf(s.db, "pack_versions")).toBe(before);
      expect(s.publicBucket.objects.size).toBe(0);
    };

    it("is left alone while an unconsumed publisher change is owed a first-publish review, and promoted once it is consumed", async () => {
      const s = await finishedRun();
      s.db.exec(`insert into publisher_changes (id, scope_id, pack_name, kind, occurred_at) values ('pc1', 's-acme', 'gcp', 'maintainer-added', 'x')`);
      await leftStaged(s);
      s.db.exec(`update publisher_changes set consumed_at = 'y'`);
      expect(await prepare(s.ctx)).toMatchObject({ promote: true });
    });

    it("is left alone for a Verified Publisher, whatever the pack's setting, and promoted once the verification is gone", async () => {
      const s = await finishedRun();
      s.db.exec(`insert into users (id, created_at) values ('u1', 'x');
        update scopes set verified_domain = 'acme.com' where id = 's-acme';
        insert into vp_applications (id, scope_id, state, applied_by, applied_at) values ('vp1', 's-acme', 'approved', 'u1', 'x');`);
      await leftStaged(s);
      s.db.exec(`update vp_applications set state = 'revoked'`);
      expect(await prepare(s.ctx)).toMatchObject({ promote: true });
    });

    it("is left alone after 180 days without a publish, and promoted when the last publish is inside the window", async () => {
      const s = await finishedRun({ version: "1.1.0" });
      s.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p-old', 's-acme', 'gcp', 'public', 'x');
        insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified, published_at)
          values ('v-old', 'p-old', '1.0.0', 'active', '${"c".repeat(64)}', 1, 0, 0, '2026-04-01T00:00:00.000Z')`);
      await leftStaged(s);
      s.db.exec(`update pack_versions set published_at = '2026-09-01T00:00:00.000Z'`);
      expect(await prepare(s.ctx)).toMatchObject({ promote: true });
    });
  });

  it("promotes a run that only warned, and counts the warning by category in meta.json", async () => {
    const s = await finishedRun({ verdict: "warn" });
    await allSteps(s);
    const meta = JSON.parse(new TextDecoder().decode(s.publicBucket.objects.get("@acme/gcp/1.0.0/meta.json")!.body));
    expect(meta.warnings).toEqual({ license: 1 });
    expect(meta.validation_run).toBe("run1");
  });

  it("leaves another run's version alone: a different hash for the same version is not this run's to promote", async () => {
    const s = await finishedRun();
    s.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p-acme', 's-acme', 'gcp', 'public', 'x');
      insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified) values ('other', 'p-acme', '1.0.0', 'active', '${"9".repeat(64)}', 1, 0, 0)`);
    expect(await prepare(s.ctx)).toEqual({ promote: false });
    expect(s.publicBucket.objects.size).toBe(0);
  });

  it("writes a private version's archive under its row id in the private bucket and nothing in the public one", async () => {
    const s = await finishedRun({ visibility: "private" });
    await allSteps(s);
    expect(s.publicBucket.objects.size).toBe(0);
    expect([...s.privateBucket.objects.keys()].sort()).toEqual(expect.arrayContaining(["@acme/gcp/1.0.0/meta.json", "@acme/gcp/1.0.0/.attestation.json"]));
    const id = (s.db.prepare(`select id from pack_versions`).get() as { id: string }).id;
    expect(s.privateBucket.objects.has(privateArchiveKey(id))).toBe(true);
    expect(rowsOf(s.db, "pack_search")).toBe(0);
  });
});
