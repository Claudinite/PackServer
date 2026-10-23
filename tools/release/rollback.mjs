#!/usr/bin/env node
// `wrangler rollback <incumbent>` per Worker in reverse release order, then the manifest
// (release.md §Rollback). Only the incumbent the manifest records is a target.
//
//   node tools/release/rollback.mjs --reason <text> [--release <id>]    (default: the live release)
import { pathToFileURL } from "node:url";
import { WORKERS, argOf, opsStore, spawnRunner, wrangler } from "./common.mjs";
import { liveRelease, readManifest, update, withState, writeLive } from "./manifest.mjs";

/** `only` limits the rollback to Workers a failed promote had already moved. */
export function rollbackRelease({ run, store, id, reason, only, root, now = new Date().toISOString(), log = console.log }) {
  const manifest = readManifest(store, id);
  const targets = WORKERS.map((w) => w.name).filter((n) => manifest.workers[n]?.changed && (!only || only.includes(n))).reverse();
  const missing = targets.filter((n) => !manifest.workers[n].incumbent?.version_id);
  if (missing.length) throw new Error(`release ${id} recorded no incumbent for ${missing.join(", ")}; nothing to roll back to`);
  const done = [];
  const failed = [];
  for (const name of targets) {
    const to = manifest.workers[name].incumbent.version_id;
    const r = wrangler(run, name, ["rollback", to, "--env", "production", "--yes", "--message", `rollback of ${id}: ${reason}`], { root });
    log(`${r.status === 0 ? "ok  " : "FAIL"} ${name} -> ${to}`);
    (r.status === 0 ? done : failed).push(name);
  }
  const record = { at: now, reason, to_release: manifest.incumbent_release, workers: done, failed };
  update(store, id, (m) => ({ ...withState(m, "rolled_back", now), rollback: record }));
  if (failed.length === 0) writeLive(store, manifest.incumbent_release);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const store = opsStore(spawnRunner);
    const reason = argOf(process.argv, "--reason");
    if (!reason) throw new Error("--reason is required");
    const id = argOf(process.argv, "--release") || liveRelease(store);
    if (!id) throw new Error("no live release to roll back");
    const record = rollbackRelease({ run: spawnRunner, store, id, reason });
    console.log(JSON.stringify(record, null, 2));
    process.exitCode = record.failed.length ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
