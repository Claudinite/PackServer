// A synchronous loop never yields, so only a deadline owned by the parent thread can stop it.
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "extracting" });
for (;;);
