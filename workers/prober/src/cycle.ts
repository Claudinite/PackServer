import type { Telemetry } from "@packserver/core/telemetry";
import type { Clock, KV } from "@packserver/ports";
import type { ProberConfig } from "./config";
import { indexProbe, INDEX_SCENARIO } from "./probes/index-check";
import { adoptProbe, mcpProbe, searchProbe } from "./probes/mcp";
import { runSelfTests, SELFTEST_PATHS, type SelfTestResult, type SelfTestWorker } from "./probes/selftest";
import { signInProbe, SIGNIN_SCENARIO } from "./probes/signin";
import { fail, type Probe, type ProbeContext, type ProbeOutcome, type Send, type Target } from "./probes/types";
import { readCandidate, targetsFor, type Candidate, type Credentials } from "./targets";
import { registrySender } from "./transport";

/** Scenarios that exercise the whole system and so count against every Worker version the target is made of. */
export const SHARED_SCENARIOS: ReadonlyArray<readonly [string, Probe]> = [
  ["adopt.public_pack", adoptProbe],
  [INDEX_SCENARIO, indexProbe],
  ["search.lexical_and_semantic", searchProbe],
  ["mcp.initialize_and_search", mcpProbe],
  [SIGNIN_SCENARIO, signInProbe],
];

/** The five-minute rhythm, and every minute while a release is in flight. */
export const cycleDue = (nowMs: number, candidate: Candidate | null): boolean => candidate !== null || new Date(nowMs).getUTCMinutes() % 5 === 0;
/** A full self-test also reaches out to its dependencies, so it runs on the five-minute mark; the minutes between are shallow. */
export const fullSelfTestDue = (nowMs: number): boolean => new Date(nowMs).getUTCMinutes() % 5 === 0;

export interface CycleDeps {
  config: ProberConfig;
  credentials: Credentials;
  clock: Clock;
  kv: KV;
  fetch: typeof fetch;
  emit: Telemetry["emit"];
}

export interface CycleResult {
  ran: boolean;
  /** Per target: scenario to outcome, for the log and the tests. */
  targets: Array<{ target: string; outcomes: Record<string, boolean> }>;
}

async function attempt(probe: Probe, ctx: ProbeContext): Promise<ProbeOutcome> {
  try {
    return await probe(ctx);
  } catch (error) {
    // Only the class: a message can carry whatever the registry answered.
    return fail(`the probe could not finish (${error instanceof Error ? error.name : "error"})`);
  }
}

function selfTestOutcome(result: SelfTestResult, expected: { versionId: string; releaseId: string } | null): ProbeOutcome {
  if (!result.ok) return fail(result.detail);
  if (expected && (result.versionId !== expected.versionId || result.releaseId !== expected.releaseId)) return fail(`${result.worker} answered as another version than the candidate`);
  return { ok: true, detail: result.detail };
}

/**
 * One probing pass: production as a visitor sees it, and the candidate through the gated host when
 * a release is in flight. Every scenario's outcome is written once per Worker version the target is
 * made of, which is what the judge's `gate.synthetic` counts per version.
 */
export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const now = deps.clock.now();
  const candidate = await readCandidate(deps.kv);
  if (!cycleDue(now, candidate)) return { ran: false, targets: [] };

  const targets = targetsFor(deps.config, deps.credentials, candidate);
  const full = fullSelfTestDue(now);
  const minute = Math.floor(now / 60_000);
  // The index and the CDN do not depend on which Workers answer, so they are asked once per pass.
  const index = attempt(indexProbe, { config: deps.config, registry: unreachable, clock: deps.clock, kv: deps.kv, fetch: deps.fetch });
  const result: CycleResult = { ran: true, targets: [] };

  const run = async (target: Target, selfTests: Send, expected: Candidate | null): Promise<void> => {
    const registry = registrySender({ reach: target.reach, expectedRelease: target.expectedRelease, clock: deps.clock, fetch: deps.fetch });
    const ctx: ProbeContext = { config: deps.config, registry, clock: deps.clock, kv: deps.kv, fetch: deps.fetch };
    const runId = `${target.name}-${minute}`;
    const [shared, selfResults] = await Promise.all([
      Promise.all(SHARED_SCENARIOS.map(async ([name, probe]) => [name, name === INDEX_SCENARIO ? await index : await attempt(probe, ctx)] as const)),
      runSelfTests(selfTests, full, expected ? Object.keys(expected.changed).filter((w): w is SelfTestWorker => w in SELFTEST_PATHS) : undefined),
    ]);

    // Production is whatever answered; a candidate is the versions its release uploaded.
    const versions = new Map<string, ProbeOutcome | null>();
    if (expected) {
      for (const [worker, versionId] of Object.entries(expected.changed)) {
        const found = selfResults.find((r) => r.worker === worker);
        // A Worker with no self-test on the gated host (admin) is judged by the shared scenarios alone.
        versions.set(versionId, found ? selfTestOutcome(found, { versionId, releaseId: expected.releaseId }) : null);
      }
    } else {
      for (const r of selfResults) {
        if (r.versionId !== null) versions.set(r.versionId, selfTestOutcome(r, null));
        else console.error(JSON.stringify({ event: "prober.selftest_unattributed", worker: r.worker, detail: r.detail }));
      }
    }

    const outcomes: Record<string, boolean> = Object.fromEntries(shared.map(([name, o]) => [name, o.ok]));
    for (const [versionId, selfTest] of versions) {
      for (const [scenario, outcome] of selfTest ? [...shared, [`selftest.${versionId}`, selfTest] as const] : shared) {
        deps.emit("synthetic.probe", {
          target: versionId,
          run: runId,
          scenario,
          ok: outcome.ok,
          ...(typeof outcome.staleS === "number" ? { stale_s: outcome.staleS } : {}),
        });
        if (!outcome.ok) console.error(JSON.stringify({ event: "prober.failed", target: target.name, scenario, detail: outcome.detail }));
      }
      if (selfTest) outcomes[`selftest.${versionId}`] = selfTest.ok;
    }
    result.targets.push({ target: target.name, outcomes });
  };

  const selfTestSender = (reach: Target["reach"], expectedRelease: string | null): Send => registrySender({ reach, expectedRelease, clock: deps.clock, fetch: deps.fetch });
  await run(targets.production, selfTestSender(targets.productionSelfTest, null), null);
  if (targets.candidate && candidate) await run(targets.candidate, selfTestSender(targets.candidate.reach, candidate.releaseId), candidate);
  return result;
}

const unreachable: Send = async () => {
  throw new Error("the index probe reads the CDN only");
};
