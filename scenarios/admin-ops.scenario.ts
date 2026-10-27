import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage", "reset"] };

/** Publishes `@<handle>/tool@1.0.0` clean and makes it the newest promoted version, which gives the scope an index to re-sign. */
async function promoted(world: World, handle: string) {
  const publisher = await world.publishers.create({ handle });
  const admitted = await publisher.publish(world.archive("gcp", { version: "1.0.0" })).as(`@${handle}/tool@1.0.0`);
  await world.validation.completes(admitted);
  await world.admins.promoted(admitted);
  return admitted;
}

/** A live public pack whose first version is the newest promoted one. */
async function live(world: World, name: string) {
  const pack = await world.packs.public(name, { versions: ["1.0.0"] });
  return pack.version("1.0.0");
}

scenario("IT-ADMIN-010 Each internal caller of the admin API is limited to a named method set; the ops page taps are its methods", async (world) => {
  const admin = await world.admins.create();
  const version = await live(world, "@rev/tool");
  const target = { pack: version.pack.systemName, version: version.version };

  // The judge's four named methods.
  expect(await world.admins.internal("judge", { method: "quarantine_version", ...target, reason: "scan" })).toMatchObject({ ok: true });
  expect(await version.status()).toBe("quarantined");
  expect(await world.admins.internal("judge", { method: "enable_new_pack_kill_switch", reason: "flood" })).toMatchObject({ ok: true });
  expect(await world.admins.internal("judge", { method: "set_telemetry_mode", mode: "economy" })).toMatchObject({ ok: true });
  expect(await world.admins.internal("judge", { method: "acknowledge_page", page: "pager-1" })).toMatchObject({ ok: true });
  expect(await admin.ops.state()).toMatchObject({ killSwitch: true, telemetryMode: "economy", acknowledged: ["pager-1"] });

  // Everything else is refused to the judge, lifting methods included, even with the admin's assertion absent.
  for (const request of [
    { method: "unquarantine_version", ...target, reason: "r" },
    { method: "disable_new_pack_kill_switch", reason: "r" },
    { method: "unfreeze_index_regeneration", reason: "r" },
    { method: "turn_flag_off", flag: "launch.flag" },
    { method: "roll_back", reason: "r" },
    { method: "yank_version", ...target, reason: "r" },
    { method: "no_such_method" },
  ]) expect(await world.admins.internal("judge", request), request.method).toMatchObject({ ok: false });
  expect(await version.status()).toBe("quarantined");
  expect((await admin.ops.state()).killSwitch).toBe(true);

  // A lifting method needs the admin app and the Access assertion.
  const lifts = [
    { method: "unquarantine_version", ...target, reason: "cleared" },
    { method: "disable_new_pack_kill_switch", reason: "over" },
  ];
  for (const request of lifts) {
    expect(await world.admins.internal("admin_app", request), `${request.method} without`).toMatchObject({ ok: false });
    expect(await world.admins.internal("admin_app", request, { assertion: "forged" }), `${request.method} forged`).toMatchObject({ ok: false });
  }
  expect(await version.status()).toBe("quarantined");
  for (const request of lifts) expect(await world.admins.internal("admin_app", request, { assertion: "valid" }), request.method).toMatchObject({ ok: true });
  expect(await version.status()).toBe("active");
  expect((await admin.ops.state()).killSwitch).toBe(false);

  // Freezing and unfreezing index regeneration, a flag off, and the roll-back method.
  expect(await world.admins.internal("admin_app", { method: "freeze_index_regeneration", reason: "audit" }, { assertion: "valid" })).toMatchObject({ ok: true });
  expect((await admin.ops.state()).indexFrozen).toBe(true);
  expect(await world.admins.internal("admin_app", { method: "unfreeze_index_regeneration", reason: "audit over" }, { assertion: "valid" })).toMatchObject({ ok: true });
  expect((await admin.ops.state()).indexFrozen).toBe(false);
  expect(await world.admins.internal("admin_app", { method: "turn_flag_off", flag: "launch.flag" }, { assertion: "valid" })).toMatchObject({ ok: true });
  // The registry starts no workflow: the roll-back method points a person at the one on GitHub.
  expect(await world.admins.internal("admin_app", { method: "roll_back", reason: "bad release" }, { assertion: "valid" })).toMatchObject({ ok: false, reason: expect.stringContaining("/actions/workflows/rollback.yml") });
  expect((await admin.ops.state()).rollbackUrl).toContain("/actions/workflows/rollback.yml");

  // Each successful call by the admin is an `admin.action` row under their address; the judge's rows are under its own name.
  const audit = await admin.audit();
  expect(audit.map((a) => a.verb)).toEqual(expect.arrayContaining(["version.unquarantine", "ops.kill_switch.off", "ops.index_freeze.off", "flag.off", "roll_back"]));
  expect(audit.every((a) => a.actor === admin.email)).toBe(true);

  const page = await admin.ops.page();
  expect(page).toEqual({ served: true, noncePolicy: true, inlineHandlers: false });
  expect(await admin.ops.tap({ method: "block_source", source: "bad.example", reason: "abuse" })).toMatchObject({ ok: true });
  expect((await admin.ops.state()).blockedSources).toEqual([expect.objectContaining({ source: "bad.example" })]);
  expect(await admin.ops.tap({ method: "unblock_source", source: "bad.example", reason: "resolved" })).toMatchObject({ ok: true });
  expect((await admin.ops.state()).blockedSources).toEqual([]);
  expect(await admin.ops.tap({ method: "no_such_method" })).toMatchObject({ ok: false });

  // The launch flag is mirrored to the telemetry store the judge reads (#221).
  await admin.flags.set("launch.flag", true);
  expect(await world.admins.launchMirror()).toContain("true");
  await admin.flags.set("launch.flag", false);
  expect(await world.admins.launchMirror()).toContain("false");
}, NEEDS);

scenario("IT-ADMIN-007 Admins process delayed recoveries and clear publishing holds on handles (hold half)", async (world) => {
  const admin = await world.admins.create();
  const owner = await world.publishers.create({ handle: "acmee" });
  await world.admins.holdHandle({ name: "acmee" });
  await expect(admin.holds.list()).resolves.toContain("acmee");
  await admin.holds.clear({ name: "acmee" });
  await expect(admin.holds.list()).resolves.not.toContain("acmee");
  const published = await owner.publish(world.archive("gcp")).as("@acmee/gcp@1.0.0");
  expect(published.version).toBe("1.0.0");
  expect((await admin.audit()).map((a) => a.verb)).toContain("hold.clear");
}, NEEDS);

scenario("IT-VAL-018 Only a human revokes: the admin's revocation re-signs the scope index (revoke half)", async (world) => {
  const admin = await world.admins.create();
  const version = await promoted(world, "p");
  await world.admins.internal("judge", { method: "quarantine_version", pack: version.pack.systemName, version: "1.0.0", reason: "scan" });
  expect(await version.status()).toBe("quarantined");
  const before = await world.registry.serial(version.pack);
  await admin.revoke(version, { reason: "malicious install step", security: "Exfiltrates credentials." });
  expect(await version.status()).toBe("revoked");
  const entry = (await world.registry.indexes(version.pack, { newerThan: before })).scope.document.packs[0]?.versions[0];
  expect(entry).toMatchObject({ status: "revoked" });
  expect((await admin.audit()).map((a) => a.verb)).toContain("version.revoke");
}, NEEDS);
