import { parentPort, workerData } from "node:worker_threads";
import type { Runtime } from "./b-exec.ts";
import { runB, type BRunInput } from "./b-run.ts";

interface WorkerInput {
  input: BRunInput;
  imageDigest: string | null;
  stepMs?: number;
  runtime?: Runtime;
}

const w = workerData as WorkerInput;
const report = await runB(w.input, {
  imageDigest: w.imageDigest,
  stepMs: w.stepMs,
  runtime: w.runtime,
  onExtracting: () => parentPort?.postMessage({ type: "extracting" }),
  onExtracted: () => parentPort?.postMessage({ type: "extracted" }),
  onSpawn: (pgid) => parentPort?.postMessage({ type: "child", pgid }),
  onProgress: (r) => parentPort?.postMessage({ type: "progress", report: r }),
});
parentPort?.postMessage({ type: "result", report });
