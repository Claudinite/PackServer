import { setInterval } from "node:timers";
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "extracted" });
setInterval(() => {}, 1000);
