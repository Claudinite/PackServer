// What the release scripts share: the Worker list in release order, a subprocess runner the tests
// replace, the wrangler calls, and the R2 `ops` store that holds manifests and bundles.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { readJsonc } from "../../infra/lib/plan.mjs";

export const REPO = join(import.meta.dirname, "..", "..");

// Callees first (release.md §Release unit and pipeline), then the two Workers that only observe
// the others. `selftest` is where the candidate answers /__selftest: the canary host unless a host is named.
export const WORKERS = [
  { name: "validator", selftest: "/validator/__selftest" },
  { name: "publish", selftest: "/api/publish/__selftest" },
  { name: "github", selftest: "/github/__selftest" },
  { name: "mcp", selftest: "/mcp/__selftest" },
  { name: "web", selftest: "/__selftest" },
  { name: "admin", selftest: "/__selftest", host: "registry-admin.claudinite.com" },
  { name: "judge", selftest: "/judge/__selftest" },
  { name: "prober", selftest: "/prober/__selftest" },
];
export const CANARY_HOST = "registry-canary.claudinite.com";
export const OPS_BUCKET = "ops";
export const MANIFEST_PREFIX = "releases";

export const workerDir = (name, root = REPO) => join(root, "workers", name);
export const envName = (name, env, root = REPO) => {
  const block = readJsonc(join(workerDir(name, root), "wrangler.jsonc")).env?.[env];
  if (!block?.name) throw new Error(`workers/${name}/wrangler.jsonc has no env.${env}.name`);
  return block.name;
};
/** Where wrangler leaves a Worker's main bundle: `<dir>/<worker>/<entry name>.js`, or `<dir>/<subdir>/` for a given subdir. */
export function bundleFile(dir, subdir, root = REPO, worker = subdir) {
  const main = readJsonc(join(workerDir(worker, root), "wrangler.jsonc")).main;
  return join(dir, subdir, `${basename(main, extname(main))}.js`);
}
/** The D1 database the schema migrations run against: the one `web` binds in this environment. */
export function dbName(env, root = REPO) {
  const name = readJsonc(join(workerDir("web", root), "wrangler.jsonc")).env?.[env]?.d1_databases?.[0]?.database_name;
  if (!name) throw new Error(`workers/web/wrangler.jsonc has no D1 database in env.${env}`);
  return name;
}
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const sha256File = (path) => sha256(readFileSync(path));

/** A runner is `(command, args, {cwd, env}) => {status, stdout, stderr}`; tests pass a recording one. */
export const spawnRunner = (command, args, { cwd = REPO, env = {} } = {}) => {
  const r = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
};

function must(result, what) {
  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  return result;
}

/** One wrangler call from inside a Worker's directory, so its own config and `--env` apply. */
export function wrangler(run, worker, args, { root = REPO, env } = {}) {
  return run("pnpm", ["exec", "wrangler", ...args], { cwd: workerDir(worker, root), env });
}
export const wranglerOk = (run, worker, args, opts) => must(wrangler(run, worker, args, opts), `wrangler ${args.slice(0, 2).join(" ")} (${worker})`);

/** The version the Worker serves at 100%; refuses a split, since an incumbent must be one version. */
export function liveVersion(run, worker, env, opts = {}) {
  const out = wranglerOk(run, worker, ["deployments", "list", "--json", "--env", env], opts).stdout;
  const deployments = JSON.parse(out.slice(out.indexOf("[")));
  const latest = [...deployments].sort((a, b) => String(a.created_on).localeCompare(String(b.created_on))).at(-1);
  if (!latest) return null;
  const whole = (latest.versions ?? []).filter((v) => v.percentage === 100);
  if (whole.length !== 1 || latest.versions.length !== 1) throw new Error(`${worker} is not at 100% on a single version; refusing to treat it as the incumbent`);
  return whole[0].version_id;
}

// An R2 miss is the only answer that means "absent"; any other failure is "could not ask" and throws.
const MISSING = /does not exist|NoSuchKey|10007/i;

/** The `ops` bucket through wrangler, remote. Keys are bucket-relative. */
export function opsStore(run, { bucket = OPS_BUCKET, root = REPO } = {}) {
  const cwd = workerDir("admin", root);
  const target = (key) => `${bucket}/${key}`;
  const wr = (args) => run("pnpm", ["exec", "wrangler", "r2", "object", ...args, "--remote"], { cwd });
  return {
    get(key) {
      const dir = mkdtempSync(join(tmpdir(), "ops-"));
      try {
        const file = join(dir, "object");
        const r = wr(["get", target(key), "--file", file]);
        if (r.status !== 0) {
          if (MISSING.test(r.stderr + r.stdout)) return null;
          must(r, `r2 get ${key}`);
        }
        return readFileSync(file);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    put(key, body, contentType = "application/json") {
      const dir = mkdtempSync(join(tmpdir(), "ops-"));
      try {
        const file = join(dir, "object");
        writeFileSync(file, body);
        must(wr(["put", target(key), "--file", file, "--content-type", contentType]), `r2 put ${key}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    /** Never overwrites: an existing identical object is fine, a different one is a hard error. */
    putOnce(key, body, contentType = "application/octet-stream") {
      const existing = this.get(key);
      if (existing) {
        if (sha256(existing) === sha256(body)) return false;
        throw new Error(`${key} already exists with different content; bundles are never overwritten`);
      }
      this.put(key, body, contentType);
      return true;
    },
  };
}

export const manifestKey = (id) => `${MANIFEST_PREFIX}/${id}.json`;
export const bundleKey = (id, worker) => `${MANIFEST_PREFIX}/bundles/${id}/${worker}.js`;
export const LIVE_POINTER = `${MANIFEST_PREFIX}/live.json`;

export const argOf = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
