import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { B_LIMITS } from "./b-limits.ts";
import { BRequest } from "./b-request.ts";
import { bErrorReport, fitToBCap, type SandboxBReport } from "./b-report.ts";
import type { BRunInput, EngineInput } from "./b-run.ts";
import { superviseB } from "./b-supervisor.ts";

export interface BMainOptions {
  inDir: string;
  outDir: string;
  imageDigest: string | null;
  workerUrl: URL;
  extractMs?: number;
  runMs?: number;
  stepMs?: number;
  preloadUrl?: string;
  /** Called once the run is over and before the report is written, so no pack process can still be writing. */
  reap?: () => void;
}

/**
 * Reads `request.json`, `canonical.tar.zst` and `cn/*.tgz` from the input directory and writes
 * `report.json` to the output directory, and nothing else: no byte B produces is ever served.
 * Whatever the outcome, a written report is a clean exit; the registry reads it from the file.
 */
export async function bMain(options: BMainOptions): Promise<SandboxBReport> {
  await mkdir(options.outDir, { recursive: true });
  const request = BRequest.parse(JSON.parse(await readFile(join(options.inDir, "request.json"), "utf8")));
  const base = { imageDigest: options.imageDigest, expectedTreeHash: request.expected_tree_hash, minEngineVersion: request.min_engine_version, oldestInMirror: request.oldest_engine_in_mirror };
  const bad = () => bErrorReport(base, "input_invalid", { extract: null, total: 0 });

  let report: SandboxBReport;
  const canonicalPath = join(options.inDir, "canonical.tar.zst");
  const sizes = await Promise.all([canonicalPath, ...request.engines.map((e) => join(options.inDir, "cn", e.file))].map((p) => stat(p).then((s) => s.size, () => -1)));
  if (sizes[0]! < 0 || sizes[0]! > B_LIMITS.canonicalFileBytes || sizes.slice(1).some((s) => s < 0 || s > B_LIMITS.releaseFileBytes)) report = bad();
  else {
    const engines: EngineInput[] = await Promise.all(
      request.engines.map(async (e) => ({ role: e.role, version: e.version, sha256: e.sha256, tgz: new Uint8Array(await readFile(join(options.inDir, "cn", e.file))) })),
    );
    const input: BRunInput = {
      pack: request.pack,
      canonical: new Uint8Array(await readFile(canonicalPath)),
      expectedTreeHash: request.expected_tree_hash,
      minEngineVersion: request.min_engine_version,
      oldestInMirror: request.oldest_engine_in_mirror,
      engines,
    };
    report = await superviseB(input, { workerUrl: options.workerUrl, imageDigest: options.imageDigest, extractMs: options.extractMs, runMs: options.runMs, stepMs: options.stepMs, preloadUrl: options.preloadUrl });
  }
  const fitted = fitToBCap(report) ?? bErrorReport(base, "report_over_cap", report.timings_ms);
  options.reap?.();
  await writeFile(join(options.outDir, "report.json"), JSON.stringify(fitted));
  return fitted;
}

/** Kills every other process in the container; it spares the caller, and is only safe where the caller does not share its machine. */
function reapEverything() {
  try {
    process.kill(-1, "SIGKILL");
  } catch {
    // Nothing else was running.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await bMain({
    inDir: process.env.SANDBOX_IN ?? "/in",
    outDir: process.env.SANDBOX_OUT ?? "/out",
    imageDigest: process.env.SANDBOX_IMAGE_DIGEST ?? null,
    workerUrl: new URL("./b-worker.mjs", import.meta.url),
    reap: process.env.SANDBOX_REAP_ALL === "1" ? reapEverything : undefined,
  });
  console.log(`sandbox-b outcome=${report.outcome} error=${report.error ?? "-"}`);
  process.exitCode = 0;
}
