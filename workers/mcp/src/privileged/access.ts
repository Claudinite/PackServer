import type { Caller as AccessCaller } from "@packserver/core/access";
import type { Caller } from "../limits";
import { allows, SCOPE_READ, SCOPE_WRITE } from "../oauth/scopes";

/** The tools that need a credential, and the scope each needs. Nothing else is privileged. */
export const PRIVILEGED_TOOLS = {
  list_my_packs: SCOPE_READ,
  star_pack: SCOPE_WRITE,
} as const;

export type PrivilegedTool = keyof typeof PRIVILEGED_TOOLS;

export const isPrivilegedTool = (name: unknown): name is PrivilegedTool => typeof name === "string" && Object.hasOwn(PRIVILEGED_TOOLS, name);

/**
 * Whether the caller's credential carries what the tool needs. A `psr_` token is a read credential and nothing
 * more; only an OAuth grant the person approved with the write scope can act for them.
 */
export function mayCall(caller: Caller, tool: PrivilegedTool): boolean {
  if (caller.kind === "anonymous") return false;
  if (caller.kind === "token") return PRIVILEGED_TOOLS[tool] === SCOPE_READ;
  return allows(caller.grant.scopes, PRIVILEGED_TOOLS[tool]);
}

/** Who the access check should read private packs for, or null when the credential reads none. */
export function accessCallerOf(caller: Caller): AccessCaller | null {
  if (caller.kind === "token") return { kind: "token", grant: caller.grant };
  if (caller.kind === "oauth" && allows(caller.grant.scopes, SCOPE_READ)) return { kind: "session", userId: caller.grant.userId };
  return null;
}
