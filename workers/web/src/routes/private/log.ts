import { githubAccountOf, recordFetches, type FetchRecord, type Caller, type PackRef } from "@packserver/core/access";
import type { PrincipalKind } from "@packserver/core/telemetry";
import { principalHash } from "@packserver/ports";
import type { Context } from "hono";
import { runtimeOf, type WebEnv } from "../../context";

export function principalOf(caller: Caller): { kind: PrincipalKind; id: string } {
  switch (caller.kind) {
    case "oidc":
      return { kind: "oidc", id: caller.ownerId };
    case "token":
      return { kind: "token", id: caller.grant.id };
    default:
      return { kind: "session", id: caller.userId };
  }
}

export const accountOf = (c: Context<WebEnv>, caller: Caller): Promise<string | null> => {
  if (caller.kind === "oidc") return Promise.resolve(caller.ownerId);
  if (caller.kind === "token") return Promise.resolve(null);
  return githubAccountOf(runtimeOf(c).ports.d1, caller.userId);
};

/** The row for one read, for the owner's view of who read the pack. */
export async function fetchRecord(
  c: Context<WebEnv>,
  caller: Caller,
  pack: Pick<PackRef, "id">,
  what: { kind: "index" | "download"; outcome: "served" | "denied"; versionId?: string },
): Promise<FetchRecord> {
  const { ports } = runtimeOf(c);
  const principal = principalOf(caller);
  const key = (await ports.telemetry.keys()).principalKey;
  return {
    packId: pack.id,
    kind: what.kind,
    outcome: what.outcome,
    caller,
    callerHash: key === undefined ? undefined : await principalHash(key, principal.kind, principal.id),
    accountId: await accountOf(c, caller),
    ...(what.versionId === undefined ? {} : { versionId: what.versionId }),
  };
}

/** Writes a request's rows; callers run it through `afterResponse`, which keeps a failure from reaching the read. */
export const writeFetches = async (c: Context<WebEnv>, records: readonly FetchRecord[]): Promise<void> => recordFetches(runtimeOf(c).ports, records);
