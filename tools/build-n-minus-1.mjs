#!/usr/bin/env node
// Lays out the incumbent release's bundles for the N/N-1 contract run: each bundle is fetched from
// `ops` and must match the manifest's SHA-256 and, once the release is finalised, the digests in its
// annotated git tag. A mismatch is a hard failure, never a skipped check.
//
//   node tools/build-n-minus-1.mjs --out <dir> [--release <id>]    (default: the live release)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, WORKERS, argOf, bundleKey, opsStore, sha256, spawnRunner } from "./release/common.mjs";
import { liveRelease, readManifest } from "./release/manifest.mjs";

export const tagName = (id) => `v${id}`;

/** Digests recorded in the release's annotated tag, or null when the tag does not exist. */
export function tagDigests(id, git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" })) {
  const message = git(["tag", "-l", "--format=%(contents)", tagName(id)]).trim();
  return message ? JSON.parse(message).digests : null;
}

export function layOutIncumbent({ store, id, out, tag = tagDigests }) {
  const manifest = readManifest(store, id);
  const fromTag = tag(id);
  if (manifest.state === "finalised" && !fromTag) throw new Error(`release ${id} is finalised but has no annotated tag ${tagName(id)}`);
  mkdirSync(out, { recursive: true });
  const digests = {};
  for (const { name } of WORKERS) {
    const body = store.get(bundleKey(id, name));
    if (!body) throw new Error(`bundle ${bundleKey(id, name)} is missing from ops`);
    const digest = sha256(body);
    if (digest !== manifest.workers[name].digest) throw new Error(`${name}: bundle digest ${digest} does not match the manifest's ${manifest.workers[name].digest}`);
    if (fromTag && fromTag[name] !== digest) throw new Error(`${name}: bundle digest ${digest} does not match the annotated tag's ${fromTag[name]}`);
    writeFileSync(join(out, `${name}.js`), body);
    digests[name] = digest;
  }
  writeFileSync(join(out, "bundles.json"), `${JSON.stringify({ release_id: id, digests }, null, 2)}\n`);
  return digests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const store = opsStore(spawnRunner);
    const id = argOf(process.argv, "--release") || liveRelease(store);
    if (!id) {
      console.log("no live release yet: nothing for the N/N-1 run to load");
    } else {
      layOutIncumbent({ store, id, out: argOf(process.argv, "--out") });
      console.log(`incumbent ${id}: ${WORKERS.length} bundles verified`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
