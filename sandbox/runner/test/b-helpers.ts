import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRunner } from "../build.mjs";

let built: Promise<{ workerUrl: URL; preloadUrl: string }> | undefined;

/** The runner as the image runs it: bundled, with the egress recorder beside it. */
export function realB(): Promise<{ workerUrl: URL; preloadUrl: string }> {
  built ??= (async () => {
    const out = await mkdtemp(join(tmpdir(), "b-runner-"));
    await buildRunner(out);
    return { workerUrl: pathToFileURL(join(out, "b-worker.mjs")), preloadUrl: pathToFileURL(join(out, "b-preload.mjs")).href };
  })();
  return built;
}
