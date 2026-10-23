#!/usr/bin/env node
// `wrangler rollback <incumbent>` per Worker in reverse release order, then the manifest
// (release.md §Rollback). Only the incumbent the manifest records is a target.
//
//   node tools/release/rollback.mjs --reason <text> [--release <id>]    (default: the live release)
import { pathToFileURL } from "node:url";
import { WORKERS, argOf, opsStore, spawnRunner, wrangler } from "./common.mjs";
import { liveRecord, readManifest, update, withState, writeLive } from "./manifest.mjs";

/**
 * `only` limits the rollback to Workers a failed promote had already moved. The manifest leaves its
 * state and live.json alone until every Worker is back, and remembers which already are, so a
 * retry finishes the job; once rolled back, a repeat does nothing.
 */
export function rollbackRelease({ run, store, id, reason, only, root, now = new Date().toISOString(), log = console.log }) {
  const live = liveRecord(store);
  if (live.rolled_back_from && live.release_id === id) throw new Error(deepRollbackMessage(live));
  const manifest = readManifest(store, id);
  const before = manifest.rollback;
  only ??= manifest.failure?.moved;
  const targets = WORKERS.map((w) => w.name).filter((n) => manifest.workers[n]?.changed && (!only || only.includes(n))).reverse();
  const missing = targets.filter((n) => !manifest.workers[n].incumbent?.version_id);
  if (missing.length) throw new Error(`release ${id} recorded no incumbent for ${missing.join(", ")}; nothing to roll back to`);
  const done = [...(before?.workers ?? [])];
  const failed = [];
  for (const name of targets.filter((n) => !done.includes(n))) {
    const to = manifest.workers[name].incumbent.version_id;
    const r = wrangler(run, name, ["rollback", to, "--env", "production", "--yes", "--message", `rollback of ${id}: ${reason}`], { root });
    log(`${r.status === 0 ? "ok  " : "FAIL"} ${name} -> ${to}`);
    (r.status === 0 ? done : failed).push(name);
  }
  const record = { at: before?.at ?? now, reason: before?.reason ?? reason, to_release: manifest.incumbent_release, workers: done, failed };
  update(store, id, (m) => {
    if (failed.length) return { ...m, rollback: record };
    return { ...(m.state === "rolled_back" ? m : withState(m, "rolled_back", now)), rollback: record };
  });
  // A repeat of a finished rollback must not repoint live at a release that has since been superseded.
  if (failed.length === 0 && (manifest.state !== "rolled_back" || live.release_id === id)) writeLive(store, manifest.incumbent_release, id);
  return record;
}

function deepRollbackMessage(live) {
  return `live is ${live.release_id}, reached by rolling back ${live.rolled_back_from}; rolling it back too would go two releases back. Going further back is a rollback-deep release (docs/operations/release.md §Rollback), not an ordinary rollback.`;
}

/** With no release id the target is the live one, unless live is itself the product of a rollback. */
export function defaultTarget(store) {
  const live = liveRecord(store);
  if (live.rolled_back_from) throw new Error(deepRollbackMessage(live));
  return live.release_id ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const store = opsStore(spawnRunner);
    const reason = argOf(process.argv, "--reason");
    if (!reason) throw new Error("--reason is required");
    const id = argOf(process.argv, "--release") || defaultTarget(store);
    if (!id) throw new Error("no live release to roll back");
    const record = rollbackRelease({ run: spawnRunner, store, id, reason });
    console.log(JSON.stringify(record, null, 2));
    process.exitCode = record.failed.length ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
