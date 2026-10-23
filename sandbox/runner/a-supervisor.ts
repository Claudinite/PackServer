import { Worker } from "node:worker_threads";
import { SandboxAReport, errorReport, refusedReport, type ReportBase } from "./a-report.ts";
import { A_LIMITS } from "./a-limits.ts";
import type { RunRequest, RunResult } from "./a-run.ts";
import { findingFactory, archiveFinding } from "@packserver/core/validation";
import { ArchiveRefusal } from "@packserver/core/canonical";
import { loadRules } from "@packserver/rules";

export interface SuperviseOptions {
  workerUrl: URL;
  imageDigest: string | null;
  extractMs?: number;
  runMs?: number;
  heapMb?: number;
}

/**
 * Runs the work in a worker thread so the deadlines hold even when the work never yields. An
 * extraction overrun is a final archive verdict; a later overrun is a timeout; a crash is an error.
 */
export function supervise(upload: Uint8Array, request: RunRequest, options: SuperviseOptions): Promise<RunResult> {
  const extractMs = options.extractMs ?? A_LIMITS.extractMs;
  const runMs = options.runMs ?? A_LIMITS.runMs;
  const base: ReportBase = { rulesVersion: request.rules_version, imageDigest: options.imageDigest };
  const make = findingFactory(loadRules(request.rules_version));
  const started = Date.now();
  const since = () => Date.now() - started;

  return new Promise((resolve) => {
    let extracted = false;
    let settled = false;
    let timer: NodeJS.Timeout;
    const worker = new Worker(options.workerUrl, {
      workerData: { upload, request, imageDigest: options.imageDigest },
      resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? A_LIMITS.workerHeapMb },
    });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const refuse = (code: string): RunResult => {
      const refusal = new ArchiveRefusal("archive.unsafe", code);
      const t = since();
      return { report: refusedReport(base, refusal.reason, code, archiveFinding(refusal, make), { extract: t, total: t }), canonical: null };
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!extracted) finish(refuse("extract-timeout"));
        else finish({ report: errorReport(base, "run exceeded its deadline", { extract: null, total: since() }, "timeout"), canonical: null });
      }, Math.max(0, ms - since()));
    };
    arm(extractMs);

    worker.on("message", (message: { type: string; report?: unknown; canonical?: Uint8Array | null }) => {
      if (message.type === "extracted") {
        extracted = true;
        arm(runMs);
      } else if (message.type === "result") {
        const parsed = SandboxAReport.safeParse(message.report);
        if (!parsed.success) finish({ report: errorReport(base, "worker report failed its schema", { extract: null, total: since() }), canonical: null });
        else finish({ report: parsed.data, canonical: message.canonical ?? null });
      }
    });
    worker.on("error", (e: Error & { code?: string }) => {
      if (e.code === "ERR_WORKER_OUT_OF_MEMORY") {
        if (!extracted) {
          const refusal = new ArchiveRefusal("archive.bomb", "memory");
          const t = since();
          finish({ report: refusedReport(base, refusal.reason, refusal.code, archiveFinding(refusal, make), { extract: t, total: t }), canonical: null });
        } else finish({ report: errorReport(base, "out of memory", { extract: null, total: since() }), canonical: null });
      } else if (!extracted) finish(refuse("extract-crash"));
      else finish({ report: errorReport(base, "worker crashed", { extract: null, total: since() }), canonical: null });
    });
    worker.on("exit", () => {
      if (!extracted) finish(refuse("extract-crash"));
      else finish({ report: errorReport(base, "worker exited without a result", { extract: null, total: since() }), canonical: null });
    });
  });
}
