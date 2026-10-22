import { z } from "zod";
import { PackName, PackVersion, ScopeName, Serial, Sha256 } from "../shapes/domain";

export const DO_RPC_SCHEMA_VERSION = 1;

/** Every Durable Object RPC result carries `schema_version`. */
function result<S extends z.ZodRawShape>(shape: S) {
  return z.object({ schema_version: z.number().int().positive(), ...shape });
}

export type DoResultAcceptance =
  | { ok: true; schema_version: number }
  | { ok: false; reason: "malformed" | "schema.unsupported"; schema_version?: number };

/** A caller at schema_version n accepts results at n and n+1. */
export function acceptDoResult(callerSchemaVersion: number, raw: unknown): DoResultAcceptance {
  const head = z.object({ schema_version: z.number().int().positive() }).safeParse(raw);
  if (!head.success) return { ok: false, reason: "malformed" };
  const n = head.data.schema_version;
  if (n !== callerSchemaVersion && n !== callerSchemaVersion + 1) {
    return { ok: false, reason: "schema.unsupported", schema_version: n };
  }
  return { ok: true, schema_version: n };
}

const ping = { args: z.tuple([]), result: result({ ok: z.literal(true) }) };

export const QUOTA_KINDS = [
  "new_packs_per_scope",
  "validation_runs",
  "dry_runs",
  "versions_per_pack",
  "reviews",
] as const;
export const QuotaKind = z.enum(QUOTA_KINDS);

/** Argument and result schemas per method, keyed by Durable Object. */
export const DO_RPC = {
  ScopeCoordinator: {
    ping,
    acquireLock: {
      args: z.tuple([z.object({ run_id: z.string().min(1), ttl_s: z.number().int().positive() })]),
      result: result({ acquired: z.boolean(), holder_run_id: z.string().nullable() }),
    },
    releaseLock: {
      args: z.tuple([z.object({ run_id: z.string().min(1) })]),
      result: result({ released: z.boolean() }),
    },
    insertVersion: {
      args: z.tuple([z.object({ run_id: z.string().min(1), pack: PackName, version: PackVersion })]),
      result: result({ promoted: z.boolean(), already_promoted: z.boolean() }),
    },
    rebuildIndex: {
      args: z.tuple([z.object({ scope: ScopeName })]),
      result: result({ sha256: Sha256, serial: Serial }),
    },
  },
  Quota: {
    ping,
    consume: {
      args: z.tuple([z.object({ kind: QuotaKind, principal: z.string().min(1), day: z.iso.date(), cap: z.number().int().positive() })]),
      result: result({ allowed: z.boolean(), count: z.number().int().nonnegative(), cap: z.number().int().positive() }),
    },
    peek: {
      args: z.tuple([z.object({ kind: QuotaKind, principal: z.string().min(1), day: z.iso.date() })]),
      result: result({ count: z.number().int().nonnegative() }),
    },
  },
  RootCoordinator: {
    ping,
    notifyScopeChange: {
      args: z.tuple([z.object({ scope: ScopeName, sha256: Sha256, serial: Serial })]),
      result: result({ queued: z.boolean() }),
    },
  },
} as const;

type Rpc = typeof DO_RPC;
type Methods<D extends keyof Rpc> = {
  [M in keyof Rpc[D]]: Rpc[D][M] extends { args: infer A extends z.ZodTuple; result: infer R extends z.ZodType }
    ? (...args: z.infer<A>) => Promise<z.infer<R>>
    : never;
};

export type ScopeCoordinatorRpc = Methods<"ScopeCoordinator">;
export type QuotaRpc = Methods<"Quota">;
export type RootCoordinatorRpc = Methods<"RootCoordinator">;
