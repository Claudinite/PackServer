import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "extracted" });
setTimeout(() => {
  throw new Error("boom");
}, 20);
