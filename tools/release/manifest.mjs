#!/usr/bin/env node
// The release manifest (docs/operations/release.md §Release unit and pipeline): its shape, its
// state machine, and `cut`, which turns built bundles into uploaded 0% versions plus a manifest.
//
//   node tools/release/manifest.mjs id
//   node tools/release/manifest.mjs cut --digests <digests.json> --bundles <dir>
//   node tools/release/manifest.mjs set --release <id> [--state <state>] [--stage <name>:<ok|fail>[:detail]]
//   node tools/release/manifest.mjs show --release <id>
//   node tools/release/manifest.mjs tag-message --release <id>    the JSON an annotated release tag carries
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIVE_POINTER, REPO, WORKERS, argOf, bundleFile, bundleKey, dbName, liveVersion, manifestKey, opsStore, sha256File, spawnRunner, wranglerOk } from "./common.mjs";

export const KINDS = ["normal", "hotfix", "lifecycle-only", "migration-only", "compat-only", "rollback-deep"];
export const STATES = ["building", "verifying", "rolling", "live", "finalised", "rolled_back"];
const NEXT = {
  building: ["verifying"],
  verifying: ["rolling"],
  rolling: ["live", "rolled_back"],
  live: ["finalised", "rolled_back"],
  finalised: ["rolled_back"],
  rolled_back: [],
};
export const CONTRACT_MARKER = /^--\s*contract-of:\s*\S+\.sql\s*$/m;
const MIGRATIONS = "packages/schema/migrations";

export function releaseId(version, sha) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version "${version}" is not plain semver`);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`"${sha}" is not a commit sha`);
  return `${version}+${sha.slice(0, 7)}`;
}

export function newManifest({ id, kind = "normal", commit, incumbentRelease, workers, migrations, now }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown release kind "${kind}"`);
  return { schema: 1, release_id: id, kind, commit, incumbent_release: incumbentRelease ?? null, state: "building", created_at: now, workers, migrations, stages: [], rollback: null };
}

/** Only the transitions of the state machine are legal; anything else means two runs are racing. */
export function withState(manifest, state, now) {
  if (!NEXT[manifest.state]?.includes(state)) throw new Error(`release ${manifest.release_id} cannot move ${manifest.state} -> ${state}`);
  return { ...manifest, state, [`${state}_at`]: now };
}

export function withStage(manifest, name, ok, detail, now) {
  return { ...manifest, stages: [...manifest.stages.filter((s) => s.name !== name), { name, ok, at: now, ...(detail ? { detail } : {}) }] };
}

/** The Workers this release uploaded, in release order. */
export const changedWorkers = (manifest) => WORKERS.map((w) => w.name).filter((n) => manifest.workers[n]?.changed);

/** Expand migrations run before any code; a contract migration is the irreversible environment's job. */
export function classifyMigrations(files, read) {
  const sql = files.filter((f) => f.endsWith(".sql")).sort();
  const contract = sql.filter((f) => CONTRACT_MARKER.test(read(f)));
  return { expand: sql.filter((f) => !contract.includes(f)), contract };
}

export const readManifest = (store, id) => {
  const raw = store.get(manifestKey(id));
  if (!raw) throw new Error(`no manifest for release ${id}`);
  return JSON.parse(raw.toString("utf8"));
};
export const writeManifest = (store, manifest) => store.put(manifestKey(manifest.release_id), `${JSON.stringify(manifest, null, 2)}\n`);
export const liveRelease = (store) => {
  const raw = store.get(LIVE_POINTER);
  return raw ? (JSON.parse(raw.toString("utf8")).release_id ?? null) : null;
};
export const writeLive = (store, id) => store.put(LIVE_POINTER, `${JSON.stringify({ release_id: id })}\n`);

/** Read-modify-write of one manifest; the caller's function returns the new manifest. */
export function update(store, id, change) {
  const next = change(readManifest(store, id));
  writeManifest(store, next);
  return next;
}

const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });

function migrationsSince(commit) {
  const dir = join(REPO, MIGRATIONS);
  const files = commit
    ? git(["diff", "--name-only", "--diff-filter=AM", `${commit}`, "HEAD", "--", MIGRATIONS]).split("\n").filter(Boolean).map((f) => f.slice(MIGRATIONS.length + 1))
    : readdirSync(dir);
  return classifyMigrations(files, (f) => readFileSync(join(dir, f), "utf8"));
}

/**
 * Cut a candidate: expand migrations, then one 0% version per Worker whose bundle changed, every
 * bundle copied once into `ops`, and the manifest left in `verifying`. Nothing here moves traffic.
 */
export function cut({ run, store, digests, bundlesDir, id, commit, now = new Date().toISOString(), root = REPO }) {
  const liveId = liveRelease(store);
  const incumbent = liveId ? readManifest(store, liveId) : null;
  const migrations = migrationsSince(incumbent?.commit);
  if (migrations.contract.length) {
    throw new Error(`contract migrations (${migrations.contract.join(", ")}) are irreversible and do not ship through this pipeline`);
  }
  const workers = {};
  for (const { name } of WORKERS) {
    const digest = digests[name];
    if (!digest) throw new Error(`no built bundle digest for ${name}`);
    const before = incumbent?.workers[name];
    workers[name] = { digest, changed: !before || before.digest !== digest, version_id: before?.version_id ?? null, incumbent: null, bundle_key: bundleKey(id, name) };
  }
  let manifest = newManifest({ id, commit, incumbentRelease: liveId, workers, migrations, now });
  writeManifest(store, manifest);
  if (migrations.expand.length) {
    wranglerOk(run, "web", ["d1", "migrations", "apply", dbName("production", root), "--env", "production", "--remote"], { root });
  }
  for (const { name } of WORKERS) {
    const w = workers[name];
    w.incumbent = w.changed || !incumbent ? versionOrNull(run, name, root) : { version_id: incumbent.workers[name].version_id };
    if (!w.changed) continue;
    w.version_id = upload(run, name, id, commit, root, w.digest);
  }
  for (const { name } of WORKERS) {
    store.putOnce(bundleKey(id, name), readFileSync(bundleFile(bundlesDir, name, root)));
  }
  manifest = withState({ ...manifest, workers }, "verifying", now);
  writeManifest(store, manifest);
  return manifest;
}

function versionOrNull(run, name, root) {
  const v = liveVersion(run, name, "production", { root });
  return v ? { version_id: v } : null;
}

function upload(run, name, id, commit, root, expectedDigest) {
  const tmp = mkdtempSync(join(tmpdir(), "upload-"));
  try {
    const out = join(tmp, "events.ndjson");
    wranglerOk(run, name, ["versions", "upload", "--env", "production", "--tag", id, "--message", `release ${id} (${commit.slice(0, 7)})`, "--outdir", join(tmp, "bundle")], { root, env: { WRANGLER_OUTPUT_FILE_PATH: out } });
    const events = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const uploaded = events.find((e) => e.type === "version-upload" && e.version_id);
    if (!uploaded) throw new Error(`wrangler reported no uploaded version for ${name}`);
    const sent = sha256File(bundleFile(tmp, "bundle", root, name));
    if (sent !== expectedDigest) throw new Error(`${name}: the uploaded bundle (${sent}) is not the one built and grepped (${expectedDigest})`);
    return uploaded.version_id;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  const [cmd] = argv;
  const run = spawnRunner;
  const store = () => opsStore(run);
  switch (cmd) {
    case "id": {
      const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
      console.log(releaseId(version, process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]).trim()));
      return;
    }
    case "cut": {
      const digests = JSON.parse(readFileSync(argOf(argv, "--digests"), "utf8"));
      const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
      const commit = process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]).trim();
      const m = cut({ run, store: store(), digests, bundlesDir: argOf(argv, "--bundles"), id: releaseId(version, commit), commit });
      console.log(JSON.stringify(m, null, 2));
      return;
    }
    case "set": {
      const id = argOf(argv, "--release");
      const state = argOf(argv, "--state");
      const stage = argOf(argv, "--stage");
      const now = new Date().toISOString();
      const next = update(store(), id, (m) => {
        let n = m;
        if (stage) {
          const [name, result, ...detail] = stage.split(":");
          n = withStage(n, name, result === "ok", detail.join(":") || undefined, now);
        }
        return state ? withState(n, state, now) : n;
      });
      console.log(`${next.release_id}: ${next.state}`);
      return;
    }
    case "tag-message": {
      const m = readManifest(store(), argOf(argv, "--release"));
      console.log(JSON.stringify({ release_id: m.release_id, commit: m.commit, digests: Object.fromEntries(Object.entries(m.workers).map(([n, w]) => [n, w.digest])) }));
      return;
    }
    case "show":
      console.log(JSON.stringify(readManifest(store(), argOf(argv, "--release")), null, 2));
      return;
    default:
      throw new Error("usage: manifest.mjs id | cut | set | show");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
