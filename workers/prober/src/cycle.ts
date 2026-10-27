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
  /** Called only when a pass is due, so an off-minute reads no secret and validates no configuration. */
  load(): Promise<{ config: ProberConfig; credentials: Credentials }>;
  clock: Clock;
  kv: KV;
  fetch: typeof fetch;
  emit: Telemetry["emit"];
}

export interface CycleResult {
  ran: boolean;
  /** Per target: version to the scenarios that failed for it, for the log and the tests. */
  targets: Array<{ target: string; failed: Record<string, string[]> }>;
}

async function attempt(probe: Probe, ctx: ProbeContext): Promise<ProbeOutcome> {
  try {
    return await probe(ctx);
  } catch (error) {
    // Only the class: a message can carry whatever the registry answered.
    return fail(`the probe could not finish (${error instanceof Error ? error.name : "error"})`);
  }
}

const versionKey = (worker: string): string => `prober/version/${worker}`;

function selfTestOutcome(result: SelfTestResult, expected: { versionId: string; releaseId: string } | null): ProbeOutcome {
  if (!result.ok) return fail(result.detail);
  if (expected && (result.versionId !== expected.versionId || result.releaseId !== expected.releaseId)) return fail(`${result.worker} answered as another version than the candidate`);
  return { ok: true, detail: result.detail };
}

/**
 * One probing pass: production as a visitor sees it, and the candidate through the gated host when
 * a release is in flight. Each Worker version the target is made of gets one summary row per pass,
 * `ok` only when every scenario held and naming the ones that did not: the judge reads this dataset
 * with a row limit, so a row per scenario would stop every gate within a day.
 */
export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const now = deps.clock.now();
  const candidate = await readCandidate(deps.kv);
  if (!cycleDue(now, candidate)) return { ran: false, targets: [] };

  const { config, credentials } = await deps.load();
  const targets = targetsFor(config, credentials, candidate);
  const full = fullSelfTestDue(now);
  const minute = Math.floor(now / 60_000);
  // The index and the CDN do not depend on which Workers answer, so they are asked once per pass.
  const index = attempt(indexProbe, { config, registry: unreachable, clock: deps.clock, kv: deps.kv, fetch: deps.fetch });
  const result: CycleResult = { ran: true, targets: [] };

  const run = async (target: Target, selfTests: Send, expected: Candidate | null): Promise<void> => {
    const registry = registrySender({ reach: target.reach, expectedRelease: target.expectedRelease, clock: deps.clock, fetch: deps.fetch });
    const ctx: ProbeContext = { config, registry, clock: deps.clock, kv: deps.kv, fetch: deps.fetch };
    const runId = `${target.name}-${minute}`;
    const [shared, selfResults] = await Promise.all([
      Promise.all(SHARED_SCENARIOS.map(async ([name, probe]) => [name, name === INDEX_SCENARIO ? await index : await attempt(probe, ctx)] as const)),
      runSelfTests(selfTests, full, expected ? Object.keys(expected.changed).filter((w): w is SelfTestWorker => w in SELFTEST_PATHS) : undefined),
    ]);

    // Production is whatever answered; a candidate is the versions its release uploaded.
    const versions = new Map<string, ProbeOutcome | null>();
    if (expected) {
      const confirmed = selfResults.some((r) => expected.changed[r.worker] === r.versionId && r.releaseId === expected.releaseId);
      for (const [worker, versionId] of Object.entries(expected.changed)) {
        const found = selfResults.find((r) => r.worker === worker);
        if (found) versions.set(versionId, selfTestOutcome(found, { versionId, releaseId: expected.releaseId }));
        // A Worker with no self-test on the gated host (admin) is credited with the shared scenarios only
        // once another changed Worker has proved, in this pass, that the override reached the candidate.
        else if (confirmed) versions.set(versionId, null);
        else console.error(JSON.stringify({ event: "prober.unconfirmed_candidate", worker }));
      }
    } else {
      for (const r of selfResults) {
        if (r.versionId !== null) {
          versions.set(r.versionId, selfTestOutcome(r, null));
          await deps.kv.put(versionKey(r.worker), r.versionId);
          continue;
        }
        // A self-test that answered nothing usable still fails the version it last answered as.
        const last = await deps.kv.get(versionKey(r.worker));
        if (last !== null) versions.set(last, fail(r.detail));
        else console.error(JSON.stringify({ event: "prober.selftest_unattributed", worker: r.worker, detail: r.detail }));
      }
    }

    const sharedFailed = shared.filter(([, o]) => !o.ok).map(([name]) => name);
    const indexOutcome = shared.find(([name]) => name === INDEX_SCENARIO)![1];
    const failedByVersion: Record<string, string[]> = {};
    for (const [versionId, selfTest] of versions) {
      const failed = [...sharedFailed, ...(selfTest && !selfTest.ok ? ["selftest"] : [])];
      failedByVersion[versionId] = failed;
      deps.emit("synthetic.probe", {
        target: versionId,
        run: runId,
        scenario: "summary",
        ok: failed.length === 0,
        index_ok: indexOutcome.ok,
        ...(failed.length > 0 ? { failed: failed.join(",") } : {}),
        ...(typeof indexOutcome.staleS === "number" ? { stale_s: indexOutcome.staleS } : {}),
      });
    }
    for (const [name, o] of shared) if (!o.ok) console.error(JSON.stringify({ event: "prober.failed", target: target.name, scenario: name, detail: o.detail }));
    for (const r of selfResults) if (!r.ok) console.error(JSON.stringify({ event: "prober.failed", target: target.name, scenario: `selftest.${r.worker}`, detail: r.detail }));
    result.targets.push({ target: target.name, failed: failedByVersion });
  };

  const selfTestSender = (reach: Target["reach"], expectedRelease: string | null): Send => registrySender({ reach, expectedRelease, clock: deps.clock, fetch: deps.fetch });
  await run(targets.production, selfTestSender(targets.productionSelfTest, null), null);
  if (targets.candidate && candidate) await run(targets.candidate, selfTestSender(targets.candidate.reach, candidate.releaseId), candidate);
  return result;
}

const unreachable: Send = async () => {
  throw new Error("the index probe reads the CDN only");
};
