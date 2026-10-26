import { recheckDomains, type ProofPorts } from "@packserver/core/scopes";
import type { AdminRuntime } from "../bindings";
import type { CronJob } from "./index";

export function proofPorts(runtime: AdminRuntime): ProofPorts {
  const { clock, rng, d1, dns, wellKnown, mail, queues } = runtime.ports;
  const reindex = queues.REINDEX_QUEUE;
  if (!reindex) throw new Error("the reindex queue is not bound");
  const siteOrigin = runtime.config?.siteOrigin;
  if (!siteOrigin) throw new Error("the site origin is not configured");
  return { clock, rng, d1, dns, wellKnown, mail, reindex, siteOrigin };
}

/** Re-checks each proven domain once it is 30 days old and removes the proofs that failed for 30 days (REQ-SCOPE-006). */
export const domainRecheck: CronJob = async (runtime) => {
  const summary = await recheckDomains(proofPorts(runtime));
  console.log(JSON.stringify({ at: "cron.domain-recheck", ...summary }));
};
