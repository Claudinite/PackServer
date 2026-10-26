import { GATES_KV_KEYS, REPORT_TTL_SECONDS, type DryRun, type GateReport, type VersionInputs, type VersionMemory } from "@packserver/core/gates";
import type { KV } from "@packserver/ports";

const MAX_DRY_RUNS = 20;

async function readJson<T>(kv: KV, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
const writeJson = (kv: KV, key: string, value: unknown, ttl = REPORT_TTL_SECONDS): Promise<void> => kv.put(key, JSON.stringify(value), { ttl_seconds: ttl });

/** The probe posts a dry run hourly, so its record has to outlive a stage. */
const DRY_RUN_TTL_SECONDS = 25 * 3600;

/** The judge's `gates` namespace: reports for the controller, and what the next cycle needs to carry on. */
export function gatesStore(kv: KV) {
  return {
    report: (versionId: string) => readJson<GateReport>(kv, GATES_KV_KEYS.report(versionId)),
    putReport: (report: GateReport) => writeJson(kv, GATES_KV_KEYS.report(report.version_id), report),
    memory: async (versionId: string): Promise<VersionMemory> => (await readJson<VersionMemory>(kv, GATES_KV_KEYS.memory(versionId))) ?? {},
    putMemory: (versionId: string, memory: VersionMemory) => writeJson(kv, GATES_KV_KEYS.memory(versionId), memory),
    inputs: (versionId: string) => readJson<VersionInputs>(kv, GATES_KV_KEYS.inputs(versionId)),
    putInputs: (inputs: VersionInputs) => writeJson(kv, GATES_KV_KEYS.inputs(inputs.versionId), inputs),
    async dryRuns(versionId: string): Promise<Array<DryRun & { runId: string }>> {
      return (await readJson<Array<DryRun & { runId: string }>>(kv, GATES_KV_KEYS.dryRuns(versionId))) ?? [];
    },
    /** Appends a dry-run result; a run id already recorded is the same run reported again and changes nothing. */
    async addDryRun(versionId: string, run: DryRun & { runId: string }): Promise<boolean> {
      const known = await this.dryRuns(versionId);
      if (known.some((r) => r.runId === run.runId)) return false;
      await writeJson(kv, GATES_KV_KEYS.dryRuns(versionId), [...known, run].sort((a, b) => a.at - b.at).slice(-MAX_DRY_RUNS), DRY_RUN_TTL_SECONDS);
      return true;
    },
  };
}
export type GatesStore = ReturnType<typeof gatesStore>;
