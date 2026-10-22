import { z } from "zod";
import { PackName, PackVersion } from "../shapes/domain";
import { Refusal } from "../shapes/refusals";

export const ADMIN_CALLERS = ["judge", "admin_app"] as const;
export type AdminCaller = (typeof ADMIN_CALLERS)[number];

export type AdminMethodPolicy = {
  readonly callers: readonly AdminCaller[];
  /** The method needs an Access assertion on the call, whoever the caller. */
  readonly requires_access_assertion: boolean;
  /** The method lifts a protection, so it always requires the Access assertion. */
  readonly lifts_protection: boolean;
};

const judgeOrAdmin = { callers: ["judge", "admin_app"], requires_access_assertion: false, lifts_protection: false } as const;
const adminOnly = { callers: ["admin_app"], requires_access_assertion: true, lifts_protection: false } as const;
const lifts = { callers: ["admin_app"], requires_access_assertion: true, lifts_protection: true } as const;

/** REQ-ADMIN-010 as data: the per-caller method sets of the admin internal API. */
export const ADMIN_METHODS = {
  quarantine_version: judgeOrAdmin,
  enable_new_pack_kill_switch: judgeOrAdmin,
  set_telemetry_mode: judgeOrAdmin,
  acknowledge_page: judgeOrAdmin,
  unquarantine_version: lifts,
  disable_new_pack_kill_switch: lifts,
  unfreeze_index_regeneration: lifts,
  turn_flag_off: lifts,
  unblock_source: lifts,
  freeze_index_regeneration: adminOnly,
  regenerate_index: adminOnly,
  block_source: adminOnly,
  turn_flag_on: adminOnly,
  yank_version: adminOnly,
} as const satisfies Record<string, AdminMethodPolicy>;

export type AdminMethod = keyof typeof ADMIN_METHODS;
export const ADMIN_METHOD_NAMES = Object.keys(ADMIN_METHODS) as AdminMethod[];

export function adminMethodsFor(caller: AdminCaller): AdminMethod[] {
  return ADMIN_METHOD_NAMES.filter((m) => (ADMIN_METHODS[m].callers as readonly AdminCaller[]).includes(caller));
}

export type AdminAuthorisation =
  | { allowed: true }
  | { allowed: false; reason: "unknown_method" | "caller_not_permitted" | "access_assertion_required" };

export function authoriseAdminCall(
  caller: AdminCaller,
  method: string,
  hasAccessAssertion: boolean,
): AdminAuthorisation {
  if (!Object.hasOwn(ADMIN_METHODS, method)) return { allowed: false, reason: "unknown_method" };
  const policy: AdminMethodPolicy = ADMIN_METHODS[method as AdminMethod];
  if (!policy.callers.includes(caller)) return { allowed: false, reason: "caller_not_permitted" };
  if (policy.requires_access_assertion && !hasAccessAssertion) {
    return { allowed: false, reason: "access_assertion_required" };
  }
  return { allowed: true };
}

const reason = z.string().min(1);
const version = { pack: PackName, version: PackVersion, reason };
const source = { source: z.string().min(1), reason };

export const AdminRequest = z.discriminatedUnion("method", [
  z.object({ method: z.literal("quarantine_version"), ...version }),
  z.object({ method: z.literal("unquarantine_version"), ...version }),
  z.object({ method: z.literal("yank_version"), ...version }),
  z.object({ method: z.literal("enable_new_pack_kill_switch"), reason }),
  z.object({ method: z.literal("disable_new_pack_kill_switch"), reason }),
  z.object({ method: z.literal("set_telemetry_mode"), mode: z.string().min(1) }),
  z.object({ method: z.literal("acknowledge_page"), page: z.string().min(1) }),
  z.object({ method: z.literal("freeze_index_regeneration"), reason }),
  z.object({ method: z.literal("unfreeze_index_regeneration"), reason }),
  z.object({ method: z.literal("regenerate_index"), scope: z.string().min(1).optional() }),
  z.object({ method: z.literal("block_source"), ...source }),
  z.object({ method: z.literal("unblock_source"), ...source }),
  z.object({ method: z.literal("turn_flag_on"), flag: z.string().min(1) }),
  z.object({ method: z.literal("turn_flag_off"), flag: z.string().min(1) }),
]);
export type AdminRequest = z.infer<typeof AdminRequest>;

/** Every call is an `admin.action` audit row; the response names it. */
export const AdminResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), audit_id: z.string().min(1) }),
  z.object({ ok: z.literal(false), refusal: Refusal, audit_id: z.string().min(1).optional() }),
]);
export type AdminResponse = z.infer<typeof AdminResponse>;
