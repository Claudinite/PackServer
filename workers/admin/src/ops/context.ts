import { createFlagCache, type FlagCache } from "@packserver/core/flags";
import { createAudit, type Audit } from "@packserver/core/audit";
import type { Clock, D1, KV, Queue } from "@packserver/ports";
import type { AdminRuntime } from "../bindings";

/** What the registry's switches and one-tap actions run on. */
export interface OpsPorts {
  d1: D1;
  clock: Clock;
  /** The Worker's `TELEMETRY_KV`, where the judge reads launch mode and the telemetry mode. */
  kv: KV;
  reindex: Queue;
  audit: Audit;
  flags: FlagCache;
  /** The admin-only key security flags are written and read under; null where it is not configured. */
  flagKey: () => Promise<string | null>;
  rollback: RollbackDispatch | null;
}

/** Starts the `rollback` workflow, which rolls the live release back to its incumbent. */
export interface RollbackDispatch {
  dispatch(reason: string): Promise<{ ok: true } | { ok: false; status: number }>;
}

export function opsPorts(runtime: AdminRuntime): OpsPorts {
  const { clock, rng, d1, queues, kv, rollback } = runtime.ports;
  const audit = queues["AUDIT_QUEUE"];
  const reindex = queues["REINDEX_QUEUE"];
  const telemetry = kv["TELEMETRY_KV"];
  if (!audit || !reindex || !telemetry) throw new Error("the admin Worker is missing a queue or the telemetry store");
  return { d1, clock, kv: telemetry, reindex, audit: createAudit({ clock, rng, queue: audit, d1 }, { ipKey: "" }), flags: runtime.ports.flagCache ?? createFlagCache(), flagKey: runtime.ports.flagKey ?? (async () => null), rollback: rollback ?? null };
}

export type AuditTrail = Audit;
