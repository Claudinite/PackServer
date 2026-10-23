import { setInterval } from "node:timers";
import { parentPort, workerData } from "node:worker_threads";
const { input } = workerData;
parentPort.postMessage({ type: "extracted" });
parentPort.postMessage({
  type: "progress",
  report: {
    schema: 1, outcome: "error", error: null, image_digest: null, pack_code_executed: true,
    tree: { expected: input.expectedTreeHash, found: input.expectedTreeHash, matches: true },
    min_engine: { declared: input.minEngineVersion, oldest_in_mirror: input.oldestInMirror, supported: true },
    engines: [{ role: "newest", version: "1.61004.1", digest_verified: true, load: { status: "loaded", exit_code: 0, file: null, message: null } }],
    compile: [], declared: [], runs: [], egress: [], egress_total: 0, egress_truncated: false,
    inventory: [], inventory_total: 0, inventory_truncated: false, token_counts: null,
    timings_ms: { extract: 1, total: 2 },
  },
});
setInterval(() => {}, 1000);
