// Holds the archive and never finishes decoding: a stuck decoder.
import { parentPort } from "node:worker_threads";
import { setInterval } from "node:timers";
parentPort.postMessage({ type: "extracting" });
setInterval(() => {}, 1000);
