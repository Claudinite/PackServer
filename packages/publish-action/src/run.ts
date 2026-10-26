import { type Canonical } from "@packserver/core/canonical";
import * as api from "./client.ts";
import { requestToken, type RunnerEnv } from "./oidc.ts";

export interface Inputs {
  pack: string;
  version: string;
  registry: string;
}

export interface Steps {
  env: RunnerEnv & { GITHUB_RUN_ID?: string; GITHUB_JOB?: string };
  fetch: typeof fetch;
  vendor(): Promise<void>;
  pack(): Promise<Canonical>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  pollMs?: number;
  maxPolls?: number;
}

export interface Outcome {
  runId: string;
  verdict: NonNullable<api.RunView["verdict"]>;
  sha256: string;
  reason: string | null;
}

/** Nothing here writes to GitHub: the verdict is read in the registry's dashboard and mailed. */
export async function publish(inputs: Inputs, steps: Steps): Promise<Outcome> {
  const { env, log } = steps;
  const io: api.Fetching = { fetch: steps.fetch, registry: inputs.registry, versionKey: env.GITHUB_RUN_ID };

  await steps.vendor();
  const canonical = await steps.pack();
  log(`packed ${inputs.pack}@${inputs.version}: ${canonical.archive.length} bytes, sha256 ${canonical.sha256}`);

  const token = await requestToken(env, steps.fetch);
  const { credential } = await api.exchange(io, { token, pack: inputs.pack, version: inputs.version, job: env.GITHUB_JOB });
  const target = await api.presign(io, credential, inputs.pack, inputs.version, canonical.archive.length);
  await api.put(io, target, canonical.archive);
  await api.confirmUploaded(io, credential, inputs.pack, inputs.version);
  let run = await api.start(io, credential, inputs.pack, inputs.version, canonical.sha256);
  log(`validation run ${run.run_id} started`);

  const interval = steps.pollMs ?? 5_000;
  for (let polls = 0; run.status !== "finished"; polls++) {
    if (polls >= (steps.maxPolls ?? 360)) throw new Error(`run ${run.run_id} did not finish in time; follow it in the dashboard`);
    await steps.sleep(interval);
    run = await api.runStatus(io, credential, run.run_id);
  }
  if (run.verdict === null) throw new Error(`run ${run.run_id} finished with no verdict`);
  return { runId: run.run_id, verdict: run.verdict, sha256: canonical.sha256, reason: run.reason };
}

/** A hold waits for a person in the dashboard, so it is not a failed step. */
export const verdictFailsJob = (verdict: Outcome["verdict"]) => verdict === "fail" || verdict === "error";
