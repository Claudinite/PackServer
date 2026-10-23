import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "result", report: { schema: 1, extra: "x".repeat(10) }, canonical: null });
