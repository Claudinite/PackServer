import { describe, expect, it } from "vitest";
import {
  ADMIN_METHODS,
  ADMIN_METHOD_NAMES,
  AdminRequest,
  AdminResponse,
  adminMethodsFor,
  authoriseAdminCall,
} from "./admin-api";

describe("admin internal API method sets (REQ-ADMIN-010)", () => {
  it("limits the judge to quarantine, kill switch on, telemetry_mode and acknowledge", () => {
    expect(adminMethodsFor("judge").sort()).toEqual(
      ["acknowledge_page", "enable_new_pack_kill_switch", "quarantine_version", "set_telemetry_mode"],
    );
  });
  it("gives the admin app every method", () => {
    expect(adminMethodsFor("admin_app").sort()).toEqual([...ADMIN_METHOD_NAMES].sort());
  });
  it("makes every protection-lifting method admin-only and Access-asserted", () => {
    const lifting = ADMIN_METHOD_NAMES.filter((m) => ADMIN_METHODS[m].lifts_protection);
    expect(lifting.sort()).toEqual(
      ["disable_new_pack_kill_switch", "turn_flag_off", "unblock_source", "unfreeze_index_regeneration", "unquarantine_version"],
    );
    for (const m of lifting) {
      expect(ADMIN_METHODS[m].callers).toEqual(["admin_app"]);
      expect(ADMIN_METHODS[m].requires_access_assertion).toBe(true);
    }
  });
  it("has a request shape for every method and no extra", () => {
    const shaped = AdminRequest.options.map((o) => o.shape.method.value).sort();
    expect(shaped).toEqual([...ADMIN_METHOD_NAMES].sort());
  });

  it("has roll_back for the admin app only, with an Access assertion", () => {
    expect(ADMIN_METHODS.roll_back.callers).toEqual(["admin_app"]);
    expect(authoriseAdminCall("judge", "roll_back", true)).toEqual({ allowed: false, reason: "caller_not_permitted" });
    expect(authoriseAdminCall("admin_app", "roll_back", false)).toEqual({ allowed: false, reason: "access_assertion_required" });
    expect(AdminRequest.safeParse({ method: "roll_back", reason: "bad release" }).success).toBe(true);
  });
  it("narrows set_telemetry_mode to normal or economy", () => {
    expect(AdminRequest.safeParse({ method: "set_telemetry_mode", mode: "economy" }).success).toBe(true);
    expect(AdminRequest.safeParse({ method: "set_telemetry_mode", mode: "off" }).success).toBe(false);
  });
  it("refuses the judge a method outside its set, even with an assertion", () => {
    expect(authoriseAdminCall("judge", "unquarantine_version", true)).toEqual({ allowed: false, reason: "caller_not_permitted" });
    expect(authoriseAdminCall("judge", "block_source", true)).toEqual({ allowed: false, reason: "caller_not_permitted" });
  });
  it("refuses an admin-app method without the Access assertion", () => {
    expect(authoriseAdminCall("admin_app", "turn_flag_off", false)).toEqual({ allowed: false, reason: "access_assertion_required" });
    expect(authoriseAdminCall("admin_app", "turn_flag_off", true)).toEqual({ allowed: true });
  });
  it("allows the judge its methods without an assertion", () => {
    expect(authoriseAdminCall("judge", "quarantine_version", false)).toEqual({ allowed: true });
  });
  it("refuses an unknown method, including inherited property names", () => {
    expect(authoriseAdminCall("admin_app", "drop_database", true)).toEqual({ allowed: false, reason: "unknown_method" });
    expect(authoriseAdminCall("admin_app", "constructor", true)).toEqual({ allowed: false, reason: "unknown_method" });
  });

  it("validates request and response bodies", () => {
    const v = { method: "quarantine_version", pack: "@acme/gcp", version: "1.0.0", reason: "report" };
    expect(AdminRequest.safeParse(v).success).toBe(true);
    expect(AdminRequest.safeParse({ ...v, reason: "" }).success).toBe(false);
    expect(AdminRequest.safeParse({ method: "nuke" }).success).toBe(false);
    expect(AdminResponse.safeParse({ ok: true, audit_id: "a1" }).success).toBe(true);
    expect(AdminResponse.safeParse({ ok: true }).success).toBe(false);
  });
});
