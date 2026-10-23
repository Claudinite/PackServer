import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "extracting" });
setTimeout(() => {
  throw new Error("decoder blew up");
}, 20);
