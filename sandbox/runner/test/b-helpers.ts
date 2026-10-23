import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRunner } from "../build.mjs";
import type { Runtime } from "../b-exec.ts";

export const STUBBED_TOOLS = ["curl", "wget", "git", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "apt-get"];

let built: Promise<{ workerUrl: URL; runtime: Runtime }> | undefined;

/** The runner as the image runs it: bundled, with the egress recorder beside it. */
export function realB(): Promise<{ workerUrl: URL; runtime: Runtime }> {
  built ??= (async () => {
    const out = await mkdtemp(join(tmpdir(), "b-runner-"));
    await buildRunner(out);
    const shimPath = join(out, "libegress.so");
    const cc = spawnSync("gcc", ["-O2", "-shared", "-fPIC", "-o", shimPath, new URL("../../image-b/egress-shim.c", import.meta.url).pathname]);
    if (cc.status !== 0) throw new Error(`the egress shim did not build: ${cc.stderr}`);
    const stubDir = join(out, "stubs");
    await mkdir(stubDir);
    for (const name of STUBBED_TOOLS) await symlink(new URL("../../image-b/stubs/stub", import.meta.url).pathname, join(stubDir, name));
    return { workerUrl: pathToFileURL(join(out, "b-worker.mjs")), runtime: { preloadUrl: pathToFileURL(join(out, "b-preload.mjs")).href, shimPath, stubDir } };
  })();
  return built;
}
