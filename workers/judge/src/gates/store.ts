import { GATES_KV_KEYS, REPORT_TTL_SECONDS, type DryRun, type GateReport, type VersionInputs, type VersionMemory } from "@packserver/core/gates";
import type { KV } from "@packserver/ports";

const MAX_DRY_RUNS = 20;

/** Where a version stands in the release and since when the judge has counted it there. */
export interface StageRecord {
  key: string;
  started_at: number;
  release_id: string;
  /** When the judge first saw this release, which a state change does not move: zero-tolerance evidence is kept from here. */
  release_started_at: number;
}

/** Longer than the whole ladder plus the 24 h bake; a stage record or a candidate's memory that lapsed would restart the stage. */
export const STAGE_TTL_SECONDS = 8 * 24 * 3600;
/** What `gate_results` last heard about a gate, so a verdict that could not be written is still news next cycle. */
export interface EmittedVerdict {
  status: string;
  decided_at: number | null;
  binding: boolean;
}

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
    putMemory: (versionId: string, memory: VersionMemory) => writeJson(kv, GATES_KV_KEYS.memory(versionId), memory, STAGE_TTL_SECONDS),
    inputs: (versionId: string) => readJson<VersionInputs>(kv, GATES_KV_KEYS.inputs(versionId)),
    putInputs: (inputs: VersionInputs) => writeJson(kv, GATES_KV_KEYS.inputs(inputs.versionId), inputs),
    stage: (versionId: string) => readJson<StageRecord>(kv, GATES_KV_KEYS.stage(versionId)),
    putStage: (versionId: string, record: StageRecord) => writeJson(kv, GATES_KV_KEYS.stage(versionId), record, STAGE_TTL_SECONDS),
    emitted: async (versionId: string): Promise<Record<string, EmittedVerdict>> => (await readJson<Record<string, EmittedVerdict>>(kv, GATES_KV_KEYS.emitted(versionId))) ?? {},
    putEmitted: (versionId: string, emitted: Record<string, EmittedVerdict>) => writeJson(kv, GATES_KV_KEYS.emitted(versionId), emitted),
    lastCycle: async (): Promise<number | null> => (await readJson<{ at: number }>(kv, GATES_KV_KEYS.lastCycle))?.at ?? null,
    putLastCycle: (at: number) => writeJson(kv, GATES_KV_KEYS.lastCycle, { at }),
    stageEnd: (versionId: string) => readJson<GateReport & { looked_at: number }>(kv, GATES_KV_KEYS.stageEnd(versionId)),
    putStageEnd: (report: GateReport & { looked_at: number }) => writeJson(kv, GATES_KV_KEYS.stageEnd(report.version_id), report),
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
