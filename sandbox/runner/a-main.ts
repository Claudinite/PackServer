import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ArchiveRefusal, LIMITS } from "@packserver/core/canonical";
import { archiveFinding, findingFactory } from "@packserver/core/validation";
import { loadRules } from "@packserver/rules";
import { errorReport, fitToCap, refusedReport, type SandboxAReport } from "./a-report.ts";
import type { RunRequest } from "./a-run.ts";
import { supervise } from "./a-supervisor.ts";

const Request = z.strictObject({
  pack: z.string(),
  newest_version: z.string().nullable(),
  rules_version: z.string(),
  lookups: z.strictObject({
    popular_packs: z.array(z.string()),
    verified_scopes: z.array(z.string()),
    proven_domain_labels: z.array(z.strictObject({ label: z.string(), scope: z.string() })),
    readable_packs: z.array(z.string()),
  }),
  previous_capabilities: z.unknown(),
});

export interface MainOptions {
  inDir: string;
  outDir: string;
  imageDigest: string | null;
  workerUrl: URL;
  extractMs?: number;
  runMs?: number;
}

/**
 * Reads `request.json` and `upload.tar.zst` from the input directory and writes `report.json` and,
 * when the upload was accepted, `canonical.tar.zst` to the output directory. Whatever the verdict,
 * a written report is a clean exit; the registry reads the verdict from the file.
 */
export async function main(options: MainOptions): Promise<SandboxAReport> {
  await mkdir(options.outDir, { recursive: true });
  const request = Request.parse(JSON.parse(await readFile(join(options.inDir, "request.json"), "utf8"))) as RunRequest;
  const uploadPath = join(options.inDir, "upload.tar.zst");

  let report: SandboxAReport;
  let canonical: Uint8Array | null = null;
  if ((await stat(uploadPath)).size > LIMITS.archiveBytes) {
    // Refused from the file's length alone, without reading it into memory.
    const refusal = new ArchiveRefusal("archive.bomb", "stored-length");
    const make = findingFactory(loadRules(request.rules_version));
    report = refusedReport({ rulesVersion: request.rules_version, imageDigest: options.imageDigest }, refusal.reason, refusal.code, archiveFinding(refusal, make), { extract: 0, total: 0 });
  } else {
    const result = await supervise(new Uint8Array(await readFile(uploadPath)), request, {
      workerUrl: options.workerUrl,
      imageDigest: options.imageDigest,
      extractMs: options.extractMs,
      runMs: options.runMs,
    });
    report = result.report;
    canonical = result.canonical;
  }

  const fitted = fitToCap(report) ?? errorReport({ rulesVersion: request.rules_version, imageDigest: options.imageDigest }, "report over the size cap", report.timings_ms);
  if (canonical && fitted.outcome === "ok") await writeFile(join(options.outDir, "canonical.tar.zst"), canonical);
  await writeFile(join(options.outDir, "report.json"), JSON.stringify(fitted));
  return fitted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await main({
    inDir: process.env.SANDBOX_IN ?? "/in",
    outDir: process.env.SANDBOX_OUT ?? "/out",
    imageDigest: process.env.SANDBOX_IMAGE_DIGEST ?? null,
    workerUrl: new URL("./a-worker.mjs", import.meta.url),
  });
  console.log(`sandbox-a outcome=${report.outcome} refusal=${report.refusal?.code ?? "-"}`);
  process.exitCode = 0;
}
