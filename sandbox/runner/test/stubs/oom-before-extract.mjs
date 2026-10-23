import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "extracting" });
const keep = [];
for (;;) keep.push(new Array(1_000_000).fill(Math.random()));
