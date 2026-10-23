import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Runtime } from "./b-exec.ts";
import { lockOut, OutDirError, reapPackProcesses } from "./b-isolation.ts";
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
  /** Egress recorders and the identity pack content runs as; with a user the runner must be root. */
  runtime?: Runtime;
}

/**
 * Reads `request.json`, `canonical.tar.zst` and `cn/*.tgz` from the input directory and writes
 * `report.json` to the output directory, and nothing else: no byte B produces is ever served.
 * The output directory must start empty and is locked against the pack identity for the whole
 * run; the report is written under a temporary name and renamed into place after every process
 * of the pack identity has been killed. An output directory that is not as expected is refused
 * with an exception, and a caller treats a failed run without a report as an infrastructure error.
 */
export async function bMain(options: BMainOptions): Promise<SandboxBReport> {
  const request = BRequest.parse(JSON.parse(await readFile(join(options.inDir, "request.json"), "utf8")));
  const base = { imageDigest: options.imageDigest, expectedTreeHash: request.expected_tree_hash, minEngineVersion: request.min_engine_version, oldestInMirror: request.oldest_engine_in_mirror };
  const user = options.runtime?.user;
  const isolated = !user || process.getuid?.() === 0;
  const out = await lockOut(options.outDir, isolated ? user : undefined);
  const bad = () => bErrorReport(base, "input_invalid", { extract: null, total: 0 });

  let report: SandboxBReport;
  const canonicalPath = join(options.inDir, "canonical.tar.zst");
  const sizes = await Promise.all([canonicalPath, ...request.engines.map((e) => join(options.inDir, "cn", e.file))].map((p) => stat(p).then((s) => s.size, () => -1)));
  if (!isolated) report = bErrorReport(base, "isolation_unavailable", { extract: null, total: 0 });
  else if (sizes[0]! < 0 || sizes[0]! > B_LIMITS.canonicalFileBytes || sizes.slice(1).some((s) => s < 0 || s > B_LIMITS.releaseFileBytes)) report = bad();
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
    report = await superviseB(input, { workerUrl: options.workerUrl, imageDigest: options.imageDigest, extractMs: options.extractMs, runMs: options.runMs, stepMs: options.stepMs, runtime: options.runtime });
  }
  const fitted = fitToBCap(report) ?? bErrorReport(base, "report_over_cap", report.timings_ms);
  if (user && isolated) await reapPackProcesses(user);
  await out.publish(JSON.stringify(fitted));
  return fitted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const uid = process.env.SANDBOX_PACK_UID ? Number(process.env.SANDBOX_PACK_UID) : undefined;
  const here = (name: string) => new URL(name, import.meta.url);
  try {
    const report = await bMain({
      inDir: process.env.SANDBOX_IN ?? "/in",
      outDir: process.env.SANDBOX_OUT ?? "/out",
      imageDigest: process.env.SANDBOX_IMAGE_DIGEST ?? null,
      workerUrl: here("./b-worker.mjs"),
      runtime: {
        preloadUrl: here("./b-preload.mjs").href,
        shimPath: process.env.SANDBOX_EGRESS_SHIM,
        user: uid === undefined ? undefined : { uid, gid: uid },
      },
    });
    console.log(`sandbox-b outcome=${report.outcome} error=${report.error ?? "-"}`);
    process.exitCode = 0;
  } catch (e) {
    console.error(`sandbox-b refused to run: ${e instanceof OutDirError ? e.message : "internal error"}`);
    process.exitCode = 2;
  }
}
