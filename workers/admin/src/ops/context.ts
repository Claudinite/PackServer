import { createHasher, createTelemetry } from "@packserver/core/telemetry";
import { createFlagCache, type FlagCache } from "@packserver/core/flags";
import { createAudit, type Audit } from "@packserver/core/audit";
import type { ModerationPorts } from "@packserver/core/moderation";
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
  /** The page that starts the `rollback` workflow; null where the environment has no release of its own to roll back. */
  rollbackUrl: string | null;
  /** What a version moving out of reach tells people: the publisher, the reporters and the judge. */
  moderation: ModerationPorts;
}

export function opsPorts(runtime: AdminRuntime): OpsPorts {
  const { clock, rng, d1, queues, kv, rollbackUrl, mail, stats } = runtime.ports;
  const audit = queues["AUDIT_QUEUE"];
  const reindex = queues["REINDEX_QUEUE"];
  const telemetry = kv["TELEMETRY_KV"];
  if (!audit || !reindex || !telemetry) throw new Error("the admin Worker is missing a queue or the telemetry store");
  const trail = createAudit({ clock, rng, queue: audit, d1 }, { ipKey: "" });
  const signals = createTelemetry({ worker: "admin", releaseId: runtime.version.releaseId, versionId: runtime.version.versionId, stats, clock, hasher: createHasher({}, clock) });
  const moderation: ModerationPorts = { clock, rng, d1, mail, reindex, audit: trail, emit: (signal, attrs) => signals.emit(signal, attrs), siteOrigin: runtime.config?.siteOrigin ?? "" };
  return { d1, clock, kv: telemetry, reindex, audit: trail, flags: runtime.ports.flagCache ?? createFlagCache(), flagKey: runtime.ports.flagKey ?? (async () => null), rollbackUrl: rollbackUrl ?? null, moderation };
}

export type AuditTrail = Audit;
