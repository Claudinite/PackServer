import { sweepGithubProofs } from "@packserver/core/scopes";
import { proofPorts } from "./domain-recheck";
import type { CronJob } from "./index";

/** Alerts the owners of an organisation whose App is gone and removes the proof 7 days after the uninstall (REQ-SCOPE-009). */
export const githubProofLapse: CronJob = async (runtime) => {
  const summary = await sweepGithubProofs(proofPorts(runtime), { ...(runtime.budget && { hasRoom: runtime.budget.hasRoom }) });
  console.log(JSON.stringify({ at: "cron.github-proof-lapse", ...summary }));
};
