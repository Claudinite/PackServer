import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigs } from "../../infra/lib/plan.mjs";
import { TEST_STRINGS } from "../test-strings.mjs";
import { layOutIncumbent } from "../build-n-minus-1.mjs";
import { REPO, WORKERS, bundleKey, manifestKey, opsStore, sha256 } from "./common.mjs";
import { changedWorkers, classifyMigrations, cut, liveRelease, newManifest, readManifest, releaseId, update, withStage, withState, writeLive, writeManifest } from "./manifest.mjs";
import { promote } from "./promote.mjs";
import { rollbackRelease } from "./rollback.mjs";
import { grepBundles, signSelftest, verifyCandidate } from "./verify.mjs";

const NAMES = WORKERS.map((w) => w.name);
const quiet = () => {};

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    get: (k) => (objects.has(k) ? Buffer.from(objects.get(k)) : null),
    put: (k, b) => void objects.set(k, Buffer.from(b)),
    putOnce(k, b) {
      if (objects.has(k)) {
        if (sha256(objects.get(k)) === sha256(b)) return false;
        throw new Error(`${k} already exists with different content`);
      }
      objects.set(k, Buffer.from(b));
      return true;
    },
  };
}

/** A runner that records wrangler calls and plays a Cloudflare account that has `serving` live. */
function fakeWrangler({ serving = {}, failOn = () => false, bundle = (w) => `// ${w} bundle` } = {}) {
  const calls = [];
  const run = (command, args, { cwd, env } = {}) => {
    const worker = cwd.split("/").at(-1);
    const sub = args.slice(2);
    calls.push({ worker, args: sub });
    if (failOn(worker, sub)) return { status: 1, stdout: "", stderr: "boom" };
    if (sub[0] === "deployments") return { status: 0, stdout: JSON.stringify([{ created_on: "2026-10-01", versions: [{ version_id: serving[worker] ?? `old-${worker}`, percentage: 100 }] }]), stderr: "" };
    if (sub[0] === "versions" && sub[1] === "upload") {
      const outdir = sub[sub.indexOf("--outdir") + 1];
      mkdirSync(outdir, { recursive: true });
      writeFileSync(join(outdir, "index.js"), bundle(worker));
      writeFileSync(env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({ type: "version-upload", version_id: `new-${worker}` })}\n`);
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const digestsOf = (bundle) => Object.fromEntries(NAMES.map((n) => [n, sha256(bundle(n))]));
const defaultBundle = (w) => `// ${w} bundle`;

function bundlesDir(bundle = defaultBundle) {
  const dir = mkdtempSync(join(tmpdir(), "bundles-"));
  for (const n of NAMES) {
    mkdirSync(join(dir, n), { recursive: true });
    writeFileSync(join(dir, n, "index.js"), bundle(n));
  }
  return dir;
}

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tracked = (d) => (dirs.push(d), d);

describe("release shape", () => {
  it("names a release <semver>+<sha7>", () => {
    expect(releaseId("1.2.3", "b518692f0a1c")).toBe("1.2.3+b518692");
    expect(() => releaseId("1.2", "b518692")).toThrow(/semver/);
    expect(() => releaseId("1.2.3", "xyz")).toThrow(/commit sha/);
  });

  it("lists every deployable Worker exactly once, in an order that puts the documented callees first", () => {
    const deployable = readConfigs().filter((c) => c.config.env?.production).map((c) => c.worker).sort();
    expect([...NAMES].sort()).toEqual(deployable);
    expect(NAMES.slice(0, 6)).toEqual(["validator", "publish", "github", "mcp", "web", "admin"]);
  });

  it("allows only the documented state transitions", () => {
    const m = newManifest({ id: "1.0.0+aaaaaaa", commit: "a".repeat(40), workers: {}, migrations: {}, now: "t" });
    const verifying = withState(m, "verifying", "t");
    expect(() => withState(m, "live", "t")).toThrow(/cannot move building -> live/);
    expect(() => withState(verifying, "finalised", "t")).toThrow();
    expect(withState(withState(verifying, "rolling", "t"), "live", "t").state).toBe("live");
    expect(withStage(withStage(m, "a", true, undefined, "t"), "a", false, "x", "u").stages).toEqual([{ name: "a", ok: false, at: "u", detail: "x" }]);
  });

  it("keeps contract migrations out of the pipeline", () => {
    const sql = { "1_a.sql": "create table t(x);", "2_b.sql": "-- contract-of: 1_a.sql\ndrop table t;" };
    expect(classifyMigrations(["1_a.sql", "2_b.sql", "x.txt"], (f) => sql[f])).toEqual({ expand: ["1_a.sql"], contract: ["2_b.sql"] });
  });
});

describe("IT-OPS-003 bundle grep", () => {
  it("passes clean bundles and names the worker and string of every hit", () => {
    const clean = tracked(bundlesDir());
    expect(grepBundles(clean)).toEqual([]);
    const dirty = tracked(bundlesDir((w) => (w === "publish" ? `const a = "${TEST_STRINGS[1]}";` : "ok")));
    expect(grepBundles(dirty)).toEqual([`publish: ${TEST_STRINGS[1]}`]);
  });
});

describe("cut", () => {
  it("uploads every Worker at 0% on a first release, records incumbents, copies bundles once, and leaves the release verifying", () => {
    const store = memoryStore();
    const { run, calls } = fakeWrangler();
    const m = cut({ run, store, digests: digestsOf(defaultBundle), bundlesDir: tracked(bundlesDir()), id: "1.0.0+aaaaaaa", commit: "a".repeat(40), now: "t" });
    expect(m.state).toBe("verifying");
    expect(changedWorkers(m)).toEqual(NAMES);
    expect(m.workers.web).toMatchObject({ version_id: "new-web", incumbent: { version_id: "old-web" }, changed: true });
    const uploads = calls.filter((c) => c.args[1] === "upload");
    expect(uploads.map((c) => c.worker)).toEqual(NAMES);
    expect(uploads[0].args).toEqual(expect.arrayContaining(["--env", "production", "--tag", "1.0.0+aaaaaaa"]));
    expect(calls.findIndex((c) => c.args[0] === "d1")).toBeLessThan(calls.findIndex((c) => c.args[1] === "upload"));
    expect(calls.some((c) => c.args[0] === "versions" && c.args[1] === "deploy")).toBe(false);
    expect(store.get(bundleKey("1.0.0+aaaaaaa", "web")).toString()).toBe("// web bundle");
    expect(readManifest(store, "1.0.0+aaaaaaa").state).toBe("verifying");
  });

  it("uploads only Workers whose bundle digest moved", () => {
    const store = memoryStore();
    const first = cut({ run: fakeWrangler().run, store, digests: digestsOf(defaultBundle), bundlesDir: tracked(bundlesDir()), id: "1.0.0+aaaaaaa", commit: "a".repeat(40), now: "t" });
    writeManifest(store, { ...first, state: "live", commit: "HEAD" });
    writeLive(store, first.release_id);
    const next = (w) => (w === "mcp" ? "// mcp changed" : defaultBundle(w));
    const { run, calls } = fakeWrangler({ bundle: next });
    const m = cut({ run, store, digests: digestsOf(next), bundlesDir: tracked(bundlesDir(next)), id: "1.0.1+bbbbbbb", commit: "b".repeat(40), now: "t" });
    expect(changedWorkers(m)).toEqual(["mcp"]);
    expect(calls.filter((c) => c.args[1] === "upload").map((c) => c.worker)).toEqual(["mcp"]);
    expect(m.workers.web.changed).toBe(false);
    expect(m.incumbent_release).toBe("1.0.0+aaaaaaa");
    expect(store.get(bundleKey("1.0.1+bbbbbbb", "web"))).not.toBeNull();
  });

  it("refuses an upload that is not the bundle that was built and grepped", () => {
    const { run } = fakeWrangler({ bundle: () => "// something else" });
    expect(() => cut({ run, store: memoryStore(), digests: digestsOf(defaultBundle), bundlesDir: tracked(bundlesDir()), id: "1.0.0+aaaaaaa", commit: "a".repeat(40), now: "t" })).toThrow(/not the one built/);
  });

  it("does not cut a release id whose manifest has moved past verifying, and can re-cut one still verifying", () => {
    const store = memoryStore();
    const args = (s) => ({ run: fakeWrangler().run, store: s, digests: digestsOf(defaultBundle), bundlesDir: tracked(bundlesDir()), id: "1.0.0+aaaaaaa", commit: "a".repeat(40), now: "t" });
    const first = cut(args(store));
    expect(cut(args(store)).state).toBe("verifying");
    for (const state of ["rolling", "live"]) {
      writeManifest(store, { ...first, state });
      expect(() => cut(args(store))).toThrow(new RegExp(`already exists and is ${state}`));
    }
    expect(readManifest(store, "1.0.0+aaaaaaa").state).toBe("live");
  });

  it("refuses when sandbox files or a Worker's containers config moved since the incumbent", () => {
    const store = memoryStore();
    const first = cut({ run: fakeWrangler().run, store, digests: digestsOf(defaultBundle), bundlesDir: tracked(bundlesDir()), id: "1.0.0+aaaaaaa", commit: "a".repeat(40), now: "t" });
    writeManifest(store, { ...first, state: "live", commit: "HEAD" });
    writeLive(store, first.release_id);
    const next = { run: fakeWrangler().run, store, digests: digestsOf(defaultBundle), bundlesDir: tracked(bundlesDir()), id: "1.0.1+bbbbbbb", commit: "b".repeat(40), now: "t" };
    const current = (path) => readFileSync(join(REPO, path), "utf8");
    const git = (sandbox, containers) => (args) => {
      if (args[0] === "diff") return args.includes("sandbox") ? sandbox : "";
      const text = current(args[1].split(":")[1]);
      return containers && args[1].includes("validator") ? text.replaceAll('"max_instances": 10', '"max_instances": 99') : text;
    };
    expect(() => cut({ ...next, gitFn: git("sandbox/image-a/Dockerfile\n", false) })).toThrow(/sandbox\/image-a\/Dockerfile changed/);
    expect(() => cut({ ...next, gitFn: git("", true) })).toThrow(/validator\/wrangler.jsonc env.production.containers changed/);
    expect(readManifest(store, "1.0.0+aaaaaaa").state).toBe("live");
    expect(cut({ ...next, gitFn: git("", false) }).state).toBe("verifying");
  });

  it("never overwrites a bundle key", () => {
    const store = memoryStore();
    store.put(bundleKey("1.0.0+aaaaaaa", "validator"), "different");
    expect(() => cut({ run: fakeWrangler().run, store, digests: digestsOf(defaultBundle), bundlesDir: tracked(bundlesDir()), id: "1.0.0+aaaaaaa", commit: "a".repeat(40), now: "t" })).toThrow(/already exists/);
  });
});

function verifyingRelease(changed = NAMES) {
  const store = memoryStore();
  const workers = Object.fromEntries(NAMES.map((n) => [n, { digest: `d-${n}`, changed: changed.includes(n), version_id: `new-${n}`, incumbent: { version_id: `old-${n}` } }]));
  writeManifest(store, withState(newManifest({ id: "2.0.0+ccccccc", commit: "c".repeat(40), incumbentRelease: "1.0.0+aaaaaaa", workers, migrations: { expand: [], contract: [] }, now: "t" }), "verifying", "t"));
  return store;
}

describe("verify", () => {
  const id = "2.0.0+ccccccc";
  const answer = (over = {}) => async (url, init) => {
    const u = new URL(url);
    const worker = WORKERS.find((w) => u.pathname === w.selftest && u.host === (w.host ?? "registry-canary.claudinite.com")).name;
    answer.seen.push({ url, init });
    return new globalThis.Response(JSON.stringify({ ok: true, version_id: `new-${worker}`, release_id: id, ...over }), { status: 200, headers: { "x-packserver-version": id } });
  };
  answer.seen = [];

  beforeEach(() => void (answer.seen.length = 0));

  it("self-tests callees first with the override, then runs probe-safe pinned to the candidate, and records both", async () => {
    const store = verifyingRelease();
    const probes = [];
    const ok = await verifyCandidate({ run: (c, a, o) => (probes.push(o.env), { status: 0, stdout: "", stderr: "" }), store, id, env: { CF_ACCESS_CLIENT_ID: "i", CF_ACCESS_CLIENT_SECRET: "s" }, fetchFn: answer(), runSelftest: true, log: quiet });
    expect(ok).toBe(true);
    expect(answer.seen.map((s) => new URL(s.url).host)).toEqual(WORKERS.map((w) => w.host ?? "registry-canary.claudinite.com"));
    expect(answer.seen[0].init.headers["Cloudflare-Workers-Version-Overrides"]).toContain('validator="new-validator"');
    expect(probes[0]).toMatchObject({ PACKSERVER_EXPECTED_RELEASE: id, TEST_DRIVER: "http", PACKSERVER_BASE_URL: "https://registry-canary.claudinite.com" });
    expect(probes[0].PACKSERVER_VERSION_OVERRIDE).toContain('web="new-web"');
    const stages = readManifest(store, id).stages;
    expect(stages.map((s) => s.name)).toEqual([...NAMES.map((n) => `selftest:${n}`), "probe-safe", "verify"]);
    expect(stages.every((s) => s.ok)).toBe(true);
  });

  it("stops at the first self-test that echoes another version, before probe-safe", async () => {
    const store = verifyingRelease();
    let probed = false;
    const ok = await verifyCandidate({ run: () => ((probed = true), { status: 0, stdout: "", stderr: "" }), store, id, env: {}, fetchFn: answer({ version_id: "someone-else" }), runSelftest: true, log: quiet });
    expect(ok).toBe(false);
    expect(probed).toBe(false);
    expect(readManifest(store, id).stages).toEqual([expect.objectContaining({ name: "selftest:validator", ok: false })]);
  });

  it("runs probe-safe alone while the self-test is not enabled, and a red probe-safe run fails verify", async () => {
    const store = verifyingRelease();
    const ok = await verifyCandidate({ run: () => ({ status: 1, stdout: "", stderr: "red" }), store, id, env: {}, fetchFn: answer(), runSelftest: false, log: quiet });
    expect(ok).toBe(false);
    expect(answer.seen).toEqual([]);
    expect(readManifest(store, id).stages.map((s) => [s.name, s.ok])).toEqual([["probe-safe", false]]);
  });

  it("signs the way the candidate gate expects", () => {
    expect(signSelftest({ key: "k", keyId: "1", method: "GET", path: "/__selftest", now: 100, nonce: "n" })).toMatch(/^t=100, n=n, k=1, v1=[0-9a-f]{64}$/);
  });
});

describe("promote", () => {
  const id = "2.0.0+ccccccc";
  const verified = (changed) => {
    const store = verifyingRelease(changed);
    update(store, id, (m) => withStage(m, "verify", true, undefined, "t"));
    return store;
  };

  it("moves every changed Worker to 100% in release order, then marks the release live", () => {
    const store = verified(["web", "validator"]);
    const { run, calls } = fakeWrangler();
    const m = promote({ run, store, id, log: quiet });
    expect(calls.map((c) => [c.worker, ...c.args.slice(0, 3)])).toEqual([
      ["validator", "versions", "deploy", "new-validator@100"],
      ["web", "versions", "deploy", "new-web@100"],
    ]);
    expect(m.state).toBe("live");
    expect(liveRelease(store)).toBe(id);
  });

  it("moves nothing unless verify passed", () => {
    const store = verifyingRelease();
    const { run, calls } = fakeWrangler();
    expect(() => promote({ run, store, id, log: quiet })).toThrow(/no passing verify/);
    expect(calls).toEqual([]);
  });

  it("rolls back only the Workers already moved when one fails, and leaves nothing live", () => {
    const store = verified(["validator", "publish", "github"]);
    const { run, calls } = fakeWrangler({ failOn: (w, a) => w === "github" && a[1] === "deploy" });
    expect(() => promote({ run, store, id, log: quiet })).toThrow(/promote stopped at github/);
    expect(calls.filter((c) => c.args[0] === "rollback").map((c) => [c.worker, c.args[1]])).toEqual([["publish", "old-publish"], ["validator", "old-validator"]]);
    expect(readManifest(store, id).state).toBe("rolled_back");
    expect(liveRelease(store)).toBe("1.0.0+aaaaaaa");
  });

  it("leaves a defined failed state when Workers moved but there is no incumbent to go back to", () => {
    const store = verified(["validator", "publish"]);
    update(store, id, (m) => ({ ...m, workers: { ...m.workers, validator: { ...m.workers.validator, incumbent: null } } }));
    const { run } = fakeWrangler({ failOn: (w, a) => w === "publish" && a[1] === "deploy" });
    expect(() => promote({ run, store, id, log: quiet })).toThrow(/1 Worker/);
    expect(readManifest(store, id)).toMatchObject({ state: "failed", failure: { moved: ["validator"] } });
  });

  it("records a failed release when the very first Worker fails", () => {
    const store = verified();
    const { run } = fakeWrangler({ failOn: () => true });
    expect(() => promote({ run, store, id, log: quiet })).toThrow(/0 Worker/);
    expect(readManifest(store, id)).toMatchObject({ state: "failed", failure: { reason: "promote failed at validator", moved: [] } });
    expect(liveRelease(store)).toBeNull();
  });
});

describe("rollback", () => {
  const id = "2.0.0+ccccccc";

  it("rolls each changed Worker back to its recorded incumbent in reverse order and repoints live", () => {
    const store = verifyingRelease(["validator", "web", "admin"]);
    update(store, id, (m) => withState(withState(m, "rolling", "t"), "live", "t"));
    const { run, calls } = fakeWrangler();
    const record = rollbackRelease({ run, store, id, reason: "bad", now: "t", log: quiet });
    expect(calls.map((c) => [c.worker, c.args[0], c.args[1]])).toEqual([["admin", "rollback", "old-admin"], ["web", "rollback", "old-web"], ["validator", "rollback", "old-validator"]]);
    expect(calls[0].args).toEqual(expect.arrayContaining(["--env", "production", "--yes"]));
    expect(record).toMatchObject({ reason: "bad", to_release: "1.0.0+aaaaaaa", failed: [] });
    expect(readManifest(store, id)).toMatchObject({ state: "rolled_back", rollback: { reason: "bad" } });
    expect(liveRelease(store)).toBe("1.0.0+aaaaaaa");
  });

  it("keeps state and live untouched until every Worker is back, and a retry finishes only what is left", () => {
    const store = verifyingRelease(["validator", "web", "admin"]);
    update(store, id, (m) => withState(withState(m, "rolling", "t"), "live", "t"));
    writeLive(store, id);
    const first = fakeWrangler({ failOn: (w) => w === "web" });
    const partial = rollbackRelease({ run: first.run, store, id, reason: "bad", now: "t", log: quiet });
    expect(partial).toMatchObject({ workers: ["admin", "validator"], failed: ["web"] });
    expect(readManifest(store, id).state).toBe("live");
    expect(liveRelease(store)).toBe(id);
    const retry = fakeWrangler();
    const done = rollbackRelease({ run: retry.run, store, id, reason: "retry", now: "u", log: quiet });
    expect(retry.calls.map((c) => c.worker)).toEqual(["web"]);
    expect(done).toMatchObject({ failed: [], reason: "bad" });
    expect(done.workers.sort()).toEqual(["admin", "validator", "web"]);
    expect(readManifest(store, id).state).toBe("rolled_back");
    expect(liveRelease(store)).toBe("1.0.0+aaaaaaa");
  });

  it("is idempotent once rolled back", () => {
    const store = verifyingRelease(["web"]);
    update(store, id, (m) => withState(withState(m, "rolling", "t"), "live", "t"));
    rollbackRelease({ run: fakeWrangler().run, store, id, reason: "bad", now: "t", log: quiet });
    const again = fakeWrangler();
    rollbackRelease({ run: again.run, store, id, reason: "bad", now: "u", log: quiet });
    expect(again.calls).toEqual([]);
    expect(readManifest(store, id).state).toBe("rolled_back");
  });

  it("finishes a failed promote by rolling back only the Workers it had moved", () => {
    const store = verifyingRelease(["validator", "web"]);
    update(store, id, (m) => ({ ...withState(withState(m, "rolling", "t"), "failed", "t"), failure: { reason: "x", moved: ["validator"] } }));
    const { run, calls } = fakeWrangler();
    rollbackRelease({ run, store, id, reason: "retry", now: "t", log: quiet });
    expect(calls.map((c) => c.worker)).toEqual(["validator"]);
    expect(readManifest(store, id).state).toBe("rolled_back");
  });

  it("refuses a release with no incumbent to go back to", () => {
    const store = verifyingRelease();
    update(store, id, (m) => ({ ...withState(withState(m, "rolling", "t"), "live", "t"), workers: { ...m.workers, web: { ...m.workers.web, incumbent: null } } }));
    expect(() => rollbackRelease({ run: fakeWrangler().run, store, id, reason: "x", log: quiet })).toThrow(/no incumbent for web/);
  });

  it("does not repoint live when a Worker would not roll back", () => {
    const store = verifyingRelease(["web"]);
    writeLive(store, id);
    update(store, id, (m) => withState(withState(m, "rolling", "t"), "live", "t"));
    const record = rollbackRelease({ run: fakeWrangler({ failOn: () => true }).run, store, id, reason: "x", log: quiet });
    expect(record.failed).toEqual(["web"]);
    expect(liveRelease(store)).toBe(id);
  });
});

describe("N/N-1 incumbent layout", () => {
  const id = "1.0.0+aaaaaaa";
  const store = () => {
    const s = memoryStore();
    const workers = {};
    for (const n of NAMES) {
      s.put(bundleKey(id, n), defaultBundle(n));
      workers[n] = { digest: sha256(defaultBundle(n)), changed: true };
    }
    writeManifest(s, withState(withState(withState(withState(newManifest({ id, commit: "a", workers, migrations: {}, now: "t" }), "verifying", "t"), "rolling", "t"), "live", "t"), "finalised", "t"));
    return s;
  };
  const tagOf = (s) => ({ ...Object.fromEntries(NAMES.map((n) => [n, sha256(defaultBundle(n))])), ...s });

  it("writes bundles that match the manifest and the tag", () => {
    const out = tracked(mkdtempSync(join(tmpdir(), "n1-")));
    layOutIncumbent({ store: store(), id, out, tag: () => tagOf({}) });
    expect(readdirSync(out).sort()).toEqual([...NAMES.map((n) => `${n}.js`), "bundles.json"].sort());
  });

  it("fails on a bundle that is not the recorded digest, a tag that disagrees, or a finalised release with no tag", () => {
    const out = tracked(mkdtempSync(join(tmpdir(), "n1-")));
    const s = store();
    s.objects.set(bundleKey(id, "web"), Buffer.from("tampered"));
    expect(() => layOutIncumbent({ store: s, id, out, tag: () => tagOf({}) })).toThrow(/does not match the manifest/);
    expect(() => layOutIncumbent({ store: store(), id, out, tag: () => tagOf({ web: "0".repeat(64) }) })).toThrow(/annotated tag/);
    expect(() => layOutIncumbent({ store: store(), id, out, tag: () => null })).toThrow(/no annotated tag/);
  });
});

describe("ops store", () => {
  const runner = (result) => (c, args) => {
    if (args.includes("get") && result.status === 0) writeFileSync(args[args.indexOf("--file") + 1], "body");
    return result;
  };

  it("reads a missing object as absent but any other failure as could-not-ask", () => {
    expect(opsStore(runner({ status: 1, stdout: "", stderr: "The specified key does not exist. [code: 10007]" })).get(manifestKey("x"))).toBeNull();
    expect(() => opsStore(runner({ status: 1, stdout: "", stderr: "Authentication error [code: 10000]" })).get(manifestKey("x"))).toThrow(/Authentication/);
    expect(opsStore(runner({ status: 0, stdout: "", stderr: "" })).get(manifestKey("x")).toString()).toBe("body");
  });

  it("addresses the ops bucket remotely", () => {
    const seen = [];
    opsStore((c, a) => (seen.push(a), { status: 1, stdout: "", stderr: "does not exist" })).get("releases/1.0.0+aaaaaaa.json");
    expect(seen[0]).toEqual(expect.arrayContaining(["r2", "object", "get", "ops/releases/1.0.0+aaaaaaa.json", "--remote"]));
  });
});
