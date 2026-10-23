import { parentPort, workerData } from "node:worker_threads";
import { loadOptionalInspectors } from "./a-inspectors.ts";
import { runA, type RunRequest } from "./a-run.ts";

interface WorkerInput {
  upload: Uint8Array;
  request: RunRequest;
  imageDigest: string | null;
}

const input = workerData as WorkerInput;
const { inspectors, skipped } = await loadOptionalInspectors();
const result = await runA(input.upload, input.request, {
  imageDigest: input.imageDigest,
  inspectors,
  skippedInspectors: skipped,
  onExtracting: () => parentPort?.postMessage({ type: "extracting" }),
  onExtracted: () => parentPort?.postMessage({ type: "extracted" }),
});
parentPort?.postMessage({ type: "result", report: result.report, canonical: result.canonical });
