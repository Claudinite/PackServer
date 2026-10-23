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
    // boot: the worker is loading; extracting: the decoder has the archive; extracted: static rules and re-pack.
    let phase: "boot" | "extracting" | "extracted" = "boot";
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
    const refusal = (reason: "archive.bomb" | "archive.unsafe", code: string): RunResult => {
      const r = new ArchiveRefusal(reason, code);
      const t = since();
      return { report: refusedReport(base, r.reason, r.code, archiveFinding(r, make), { extract: t, total: t }), canonical: null };
    };
    const failure = (error: string, outcome: "error" | "timeout" = "error"): RunResult => ({
      report: errorReport(base, error, { extract: null, total: since() }, outcome),
      canonical: null,
    });
    // Only a failure while the decoder held the archive says anything about the archive.
    const crashed = (what: string): RunResult => (phase === "extracting" ? refusal("archive.unsafe", "extract-crash") : failure(what));

    const arm = (deadlineAt: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (phase === "extracting") finish(refusal("archive.unsafe", "extract-timeout"));
        else finish(failure(phase === "boot" ? "worker did not start" : "run exceeded its deadline", phase === "boot" ? "error" : "timeout"));
      }, Math.max(0, deadlineAt - Date.now()));
    };
    arm(started + runMs);

    worker.on("message", (message: { type: string; report?: unknown; canonical?: Uint8Array | null }) => {
      if (message.type === "extracting") {
        phase = "extracting";
        arm(Math.min(Date.now() + extractMs, started + runMs));
      } else if (message.type === "extracted") {
        phase = "extracted";
        arm(started + runMs);
      } else if (message.type === "result") {
        const parsed = SandboxAReport.safeParse(message.report);
        if (!parsed.success) finish(failure("worker report failed its schema"));
        else finish({ report: parsed.data, canonical: message.canonical ?? null });
      }
    });
    worker.on("error", (e: Error & { code?: string }) => {
      if (e.code === "ERR_WORKER_OUT_OF_MEMORY") finish(phase === "extracting" ? refusal("archive.bomb", "memory") : failure("out of memory"));
      else finish(crashed("worker crashed"));
    });
    worker.on("exit", () => finish(crashed("worker exited without a result")));
  });
}
