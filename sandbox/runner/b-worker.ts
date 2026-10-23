import { parentPort, workerData } from "node:worker_threads";
import { runB, type BRunInput } from "./b-run.ts";

interface WorkerInput {
  input: BRunInput;
  imageDigest: string | null;
  stepMs?: number;
  preloadUrl?: string;
}

const w = workerData as WorkerInput;
const report = await runB(w.input, {
  imageDigest: w.imageDigest,
  stepMs: w.stepMs,
  preloadUrl: w.preloadUrl,
  onExtracting: () => parentPort?.postMessage({ type: "extracting" }),
  onExtracted: () => parentPort?.postMessage({ type: "extracted" }),
  onSpawn: (pgid) => parentPort?.postMessage({ type: "child", pgid }),
  onProgress: (r) => parentPort?.postMessage({ type: "progress", report: r }),
});
parentPort?.postMessage({ type: "result", report });
