#!/usr/bin/env node
// Pre-launch promotion (release.md §Pre-launch mode): every uploaded version to 100%, all at once,
// callees first, only after verify passed for all of them. A failure partway rolls back the
// Workers already moved, so the release is never left half promoted.
//
//   node tools/release/promote.mjs release --release <id>
//   node tools/release/promote.mjs staging
import { pathToFileURL } from "node:url";
import { WORKERS, argOf, dbName, opsStore, spawnRunner, wrangler, wranglerOk } from "./common.mjs";
import { changedWorkers, readManifest, update, withState, writeLive } from "./manifest.mjs";
import { rollbackRelease } from "./rollback.mjs";

export function promote({ run, store, id, root, now = () => new Date().toISOString(), log = console.log }) {
  const manifest = readManifest(store, id);
  if (manifest.state !== "verifying") throw new Error(`release ${id} is ${manifest.state}; only a verifying release promotes`);
  if (!manifest.stages.some((s) => s.name === "verify" && s.ok)) throw new Error(`release ${id} has no passing verify stage; nothing moves`);
  const names = changedWorkers(manifest);
  update(store, id, (m) => withState(m, "rolling", now()));
  const moved = [];
  for (const name of names) {
    const r = wrangler(run, name, ["versions", "deploy", `${manifest.workers[name].version_id}@100`, "--env", "production", "--yes", "--message", `release ${id}`], { root });
    log(`${r.status === 0 ? "ok  " : "FAIL"} ${name} -> 100%`);
    if (r.status !== 0) {
      log((r.stderr || r.stdout).slice(-2000));
      if (moved.length) rollbackRelease({ run, store, id, reason: `promote failed at ${name}`, only: moved, root, now: now(), log });
      else update(store, id, (m) => ({ ...withState(m, "rolled_back", now()), rollback: { at: now(), reason: `promote failed at ${name}`, to_release: m.incumbent_release, workers: [], failed: [] } }));
      throw new Error(`promote stopped at ${name}; ${moved.length} Worker(s) moved back`);
    }
    moved.push(name);
  }
  const live = update(store, id, (m) => withState(m, "live", now()));
  writeLive(store, id);
  return live;
}

/** Everything that lands on the staging environment: migrations, then each Worker in release order. */
export function deployStaging({ run, root, log = console.log }) {
  wranglerOk(run, "web", ["d1", "migrations", "apply", dbName("staging", root), "--env", "staging", "--remote"], { root });
  for (const { name } of WORKERS) {
    wranglerOk(run, name, ["deploy", "--env", "staging"], { root });
    log(`ok   ${name} deployed to staging`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [cmd] = process.argv.slice(2);
    if (cmd === "release") {
      const live = promote({ run: spawnRunner, store: opsStore(spawnRunner), id: argOf(process.argv, "--release") });
      console.log(`${live.release_id}: ${live.state}`);
    } else if (cmd === "staging") {
      deployStaging({ run: spawnRunner });
    } else {
      throw new Error("usage: promote.mjs release --release <id> | staging");
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
