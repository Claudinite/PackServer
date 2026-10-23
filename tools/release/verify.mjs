#!/usr/bin/env node
// Everything that judges a candidate before it takes traffic.
//
//   node tools/release/verify.mjs build --out <dir>        production bundles + <dir>/digests.json
//   node tools/release/verify.mjs grep --out <dir>          IT-OPS-003: no test string in any bundle
//   node tools/release/verify.mjs candidate --release <id>  self-test (opt-in) then probe-safe, pinned to the candidate
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TEST_STRINGS } from "../test-strings.mjs";
import { CANARY_HOST, REPO, WORKERS, argOf, bundleFile, envName, opsStore, sha256File, spawnRunner, wranglerOk } from "./common.mjs";
import { changedWorkers, readManifest, update, withStage } from "./manifest.mjs";

/** Builds every Worker as `wrangler deploy` would ship it, without uploading anything. */
export function buildBundles(run, outDir, root = REPO) {
  const digests = {};
  for (const { name } of WORKERS) {
    wranglerOk(run, name, ["deploy", "--dry-run", "--containers-rollout", "none", "--env", "production", "--outdir", join(resolve(outDir), name)], { root });
    digests[name] = sha256File(bundleFile(resolve(outDir), name, root));
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "digests.json"), `${JSON.stringify(digests, null, 2)}\n`);
  return digests;
}

/** The IT-OPS-003 bundle half: every test string found in a bundle, as `worker: string`. */
export function grepBundles(outDir, root = REPO, strings = TEST_STRINGS) {
  return WORKERS.flatMap(({ name }) => {
    const text = readFileSync(bundleFile(resolve(outDir), name, root), "utf8");
    return strings.filter((s) => text.includes(s)).map((s) => `${name}: ${s}`);
  });
}

/** `Cloudflare-Workers-Version-Overrides` names Workers by their deployed name, not their directory. */
export function overrideHeader(manifest, root = REPO) {
  return changedWorkers(manifest).map((w) => `${envName(w, "production", root)}="${manifest.workers[w].version_id}"`).join(", ");
}

/** X-Selftest-Signature as release.md §Candidate gating defines it. */
export function signSelftest({ key, keyId, method, path, now, nonce }) {
  const v1 = createHmac("sha256", key).update(`${method}|${path}|${now}|${nonce}`).digest("hex");
  return `t=${now}, n=${nonce}, k=${keyId}, v1=${v1}`;
}

/** One candidate's self-test: the version must echo itself, or the override was silently ignored. */
export async function selftest({ fetchFn = fetch, worker, manifest, override, access, hmac, now = Math.floor(Date.now() / 1000) }) {
  const spec = WORKERS.find((w) => w.name === worker);
  const host = spec.host ?? CANARY_HOST;
  const headers = { "Cloudflare-Workers-Version-Overrides": override };
  if (access) {
    headers["CF-Access-Client-Id"] = access.id;
    headers["CF-Access-Client-Secret"] = access.secret;
  }
  if (hmac) headers["X-Selftest-Signature"] = signSelftest({ key: hmac.key, keyId: hmac.keyId, method: "GET", path: spec.selftest, now, nonce: randomUUID() });
  const res = await fetchFn(`https://${host}${spec.selftest}`, { headers, redirect: "manual" });
  if (res.status !== 200) return { ok: false, detail: `${worker} self-test answered ${res.status}` };
  const body = await res.json();
  const want = manifest.workers[worker].version_id;
  if (body.version_id !== want) return { ok: false, detail: `${worker} answered as version ${body.version_id}, not the candidate ${want}` };
  if (body.release_id !== manifest.release_id) return { ok: false, detail: `${worker} reports release ${body.release_id}, not ${manifest.release_id}` };
  const header = res.headers.get("x-packserver-version");
  if (header !== manifest.release_id) return { ok: false, detail: `${worker} X-PackServer-Version is ${header}` };
  if (body.ok !== true) return { ok: false, detail: `${worker} self-test failed: ${(body.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(", ")}` };
  return { ok: true };
}

/** probe-safe scenarios over `http`, every call pinned to the candidate and asserted by the driver. */
export function probeSafe(run, manifest, override, env, root = REPO) {
  return run("pnpm", ["exec", "vitest", "run", "--project", "scenarios", "--tagsFilter", "probe-safe", "--passWithNoTests", "--reporter=default", "--reporter=junit", "--outputFile.junit=reports/scenarios.xml"], {
    cwd: root,
    env: {
      TEST_DRIVER: "http",
      PACKSERVER_BASE_URL: `https://${CANARY_HOST}`,
      PACKSERVER_ACCESS_HOST: CANARY_HOST,
      PACKSERVER_VERSION_OVERRIDE: override,
      PACKSERVER_EXPECTED_RELEASE: manifest.release_id,
      PACKSERVER_PROBE_TENANT: env.PACKSERVER_PROBE_TENANT ?? "@probe",
      CF_ACCESS_CLIENT_ID: env.CF_ACCESS_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: env.CF_ACCESS_CLIENT_SECRET,
    },
  });
}

/**
 * Callees first, fail fast. `runSelftest` is off until the self-test endpoint exists (T-110): the
 * probe-safe run below still asserts the release header on every response meanwhile.
 */
export async function verifyCandidate({ run, store, id, env, fetchFn, runSelftest, root = REPO, log = console.log }) {
  const manifest = readManifest(store, id);
  if (manifest.state !== "verifying") throw new Error(`release ${id} is ${manifest.state}, not verifying`);
  const override = overrideHeader(manifest, root);
  const access = env.CF_ACCESS_CLIENT_ID ? { id: env.CF_ACCESS_CLIENT_ID, secret: env.CF_ACCESS_CLIENT_SECRET } : null;
  const hmac = env.SELFTEST_HMAC_KEY ? { key: env.SELFTEST_HMAC_KEY, keyId: env.SELFTEST_KEY_ID ?? "1" } : null;
  const record = (name, result) => update(store, id, (m) => withStage(m, name, result.ok, result.detail, new Date().toISOString()));
  if (changedWorkers(manifest).length === 0) {
    record("verify", { ok: true, detail: "no Worker changed" });
    return true;
  }
  if (runSelftest) {
    for (const worker of changedWorkers(manifest)) {
      const result = await selftest({ fetchFn, worker, manifest, override, access, hmac });
      record(`selftest:${worker}`, result);
      log(`${result.ok ? "ok  " : "FAIL"} selftest ${worker}${result.detail ? `: ${result.detail}` : ""}`);
      if (!result.ok) return false;
    }
  }
  const probe = probeSafe(run, manifest, override, env, root);
  const ok = probe.status === 0;
  record("probe-safe", { ok, detail: ok ? undefined : `exit ${probe.status}` });
  log(`${ok ? "ok  " : "FAIL"} probe-safe\n${(probe.stdout + probe.stderr).slice(-3000)}`);
  if (!ok) return false;
  record("verify", { ok: true });
  return true;
}

async function main(argv) {
  const [cmd] = argv;
  if (cmd === "build") {
    const digests = buildBundles(spawnRunner, argOf(argv, "--out"));
    console.log(JSON.stringify(digests, null, 2));
  } else if (cmd === "grep") {
    const hits = grepBundles(argOf(argv, "--out"));
    for (const h of hits) console.error(`test string in a production bundle: ${h}`);
    console.log(hits.length ? `${hits.length} hit(s)` : "no test string in any production bundle");
    process.exitCode = hits.length ? 1 : 0;
  } else if (cmd === "candidate") {
    const ok = await verifyCandidate({ run: spawnRunner, store: opsStore(spawnRunner), id: argOf(argv, "--release"), env: process.env, runSelftest: process.env.VERIFY_SELFTEST === "true" });
    process.exitCode = ok ? 0 : 1;
  } else {
    throw new Error("usage: verify.mjs build | grep | candidate");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
