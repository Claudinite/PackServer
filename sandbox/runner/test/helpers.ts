import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRunner } from "../build.mjs";
import type { RunRequest } from "../a-run.ts";

export const REQUEST: RunRequest = {
  pack: "@acme/gcp",
  newest_version: null,
  rules_version: "2026.10.1",
  lookups: { popular_packs: [], verified_scopes: ["acme"], proven_domain_labels: [], readable_packs: [] },
  previous_capabilities: null,
};

export const stub = (name: string) => new URL(`./stubs/${name}`, import.meta.url);
let built: Promise<URL> | undefined;

/** The worker as the image runs it: bundled, because Node cannot load the workspace sources directly. */
export function realWorker(): Promise<URL> {
  built ??= (async () => {
    const out = await mkdtemp(join(tmpdir(), "a-runner-"));
    await buildRunner(out);
    return pathToFileURL(join(out, "a-worker.mjs"));
  })();
  return built;
}
