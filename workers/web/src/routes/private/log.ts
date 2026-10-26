import { githubAccountOf, recordFetch, type Caller, type PackRef } from "@packserver/core/access";
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

/** One row in the owner's view of who read the pack. */
export async function logFetch(
  c: Context<WebEnv>,
  caller: Caller,
  pack: Pick<PackRef, "id">,
  what: { kind: "index" | "download"; outcome: "served" | "denied"; versionId?: string },
): Promise<void> {
  const { ports } = runtimeOf(c);
  const principal = principalOf(caller);
  const key = (await ports.telemetry.keys()).principalKey;
  await recordFetch(ports, {
    packId: pack.id,
    kind: what.kind,
    outcome: what.outcome,
    caller,
    callerHash: key === undefined ? undefined : await principalHash(key, principal.kind, principal.id),
    accountId: await accountOf(c, caller),
    ...(what.versionId === undefined ? {} : { versionId: what.versionId }),
  });
}
