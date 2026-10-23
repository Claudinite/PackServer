import { Worker } from "node:worker_threads";
import { B_LIMITS } from "./b-limits.ts";
import { bErrorReport, emptyBReport, SandboxBReport, type BReportBase } from "./b-report.ts";
import type { BRunInput } from "./b-run.ts";

export interface BSuperviseOptions {
  workerUrl: URL;
  imageDigest: string | null;
  extractMs?: number;
  runMs?: number;
  heapMb?: number;
  stepMs?: number;
  preloadUrl?: string;
}

/**
 * Runs the work in a worker thread so the deadlines hold even when the work never yields. The
 * extraction deadline and a crash are infrastructure errors (the archive was produced by sandbox A,
 * so a decoder that fails on it is not a verdict on the publisher); the run deadline is a timeout
 * that keeps whatever the run had recorded. Every pack process group is killed on the way out.
 */
export function superviseB(input: BRunInput, options: BSuperviseOptions): Promise<SandboxBReport> {
  const extractMs = options.extractMs ?? B_LIMITS.extractMs;
  const runMs = options.runMs ?? B_LIMITS.runMs;
  const base: BReportBase = { imageDigest: options.imageDigest, expectedTreeHash: input.expectedTreeHash, minEngineVersion: input.minEngineVersion, oldestInMirror: input.oldestInMirror };
  const started = Date.now();
  const since = () => Date.now() - started;

  return new Promise((resolve) => {
    let phase: "boot" | "extracting" | "extracted" = "boot";
    let settled = false;
    let timer: NodeJS.Timeout;
    let last: SandboxBReport | null = null;
    const groups = new Set<number>();
    const worker = new Worker(options.workerUrl, {
      workerData: { input, imageDigest: options.imageDigest, stepMs: options.stepMs, preloadUrl: options.preloadUrl },
      resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? B_LIMITS.workerHeapMb },
    });

    const finish = (report: SandboxBReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      for (const g of groups) {
        try {
          process.kill(-g, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      resolve(report);
    };
    const failure = (error: Parameters<typeof bErrorReport>[1], outcome: "error" | "timeout" = "error") => bErrorReport(base, error, { extract: null, total: since() }, outcome);
    const arm = (deadlineAt: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (phase === "extracting") finish(failure("extract_timeout"));
        else if (phase === "boot") finish(failure("worker_start_timeout"));
        else finish(last ? { ...last, outcome: "timeout", error: null, timings_ms: { ...last.timings_ms, total: since() } } : { ...emptyBReport(base), outcome: "timeout", timings_ms: { extract: null, total: since() } });
      }, Math.max(0, deadlineAt - Date.now()));
    };
    arm(started + runMs);

    worker.on("message", (m: { type: string; report?: unknown; pgid?: number }) => {
      if (m.type === "extracting") {
        phase = "extracting";
        arm(Math.min(Date.now() + extractMs, started + runMs));
      } else if (m.type === "extracted") {
        phase = "extracted";
        arm(started + runMs);
      } else if (m.type === "child" && typeof m.pgid === "number") groups.add(m.pgid);
      else if (m.type === "progress" || m.type === "result") {
        const parsed = SandboxBReport.safeParse(m.report);
        if (!parsed.success) finish(failure("report_invalid"));
        else if (m.type === "progress") last = parsed.data;
        else finish(parsed.data);
      }
    });
    worker.on("error", (e: Error & { code?: string }) => finish(failure(e.code === "ERR_WORKER_OUT_OF_MEMORY" ? "out_of_memory" : "crashed")));
    worker.on("exit", () => finish(failure("crashed")));
  });
}
