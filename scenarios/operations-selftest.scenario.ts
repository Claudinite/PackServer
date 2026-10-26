import { expect, scenario, type World } from "@packserver/test-world";

const DETAILS = ["ok", "failed", "timeout", "error"];
const STORES = ["web", "mcp", "publish", "github", "validator", "admin"];
const unique = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
const workersOf = (world: World) => world.operator.reachable();

scenario("IT-OPS-004 Self-test is invisible to anonymous callers and does no paid work", async (world) => {
  for (const worker of workersOf(world)) {
    await expect(world.visitor().selfTest({ worker })).toBeNotFound();
    const answered = await world.operator.selfTest({ worker });
    expect(answered.versionId).not.toBe("");
    for (const check of answered.checks) expect(DETAILS).toContain(check.detail);
  }
  const web = await world.operator.selfTest({ worker: "web" });
  expect(web.check("service.mcp")).toMatchObject({ ok: true });
  expect(web.check("service.publish")).toMatchObject({ ok: true });

  expect(await world.github.writes()).toEqual([]);
  expect(world.github.tokensMinted()).toBe(0);
  const wire = await world.recorder.invocations({ raw: true });
  expect(new Set(wire.map((call) => call.target))).toEqual(new Set(["api.github.com"]));
}, { needs: ["fakes"] });

scenario("IT-OPS-005 The self-test reports in a fixed shape with the answering version", async (world) => {
  for (const worker of workersOf(world)) {
    const result = await world.operator.selfTest({ worker });
    expect(result.versionId).not.toBe("");
    expect(result.releaseId).toBe(world.operator.deployedVersion());
    expect(result.ok).toBe(result.checks.every((check) => check.ok));
    expect(result.ok).toBe(true);
    for (const check of result.checks) {
      expect(typeof check.ms).toBe("number");
      expect(DETAILS).toContain(check.detail);
    }
  }

  world.github.failApi(503);
  const failing = await world.operator.selfTest({ worker: "github" });
  expect(failing.ok).toBe(false);
  expect(failing.check("outbound.github-app")).toMatchObject({ ok: false, detail: "failed" });
  expect(failing.checks.filter((check) => !check.ok)).toHaveLength(1);
}, { needs: ["fakes"] });

scenario("IT-OPS-007 Checks time out individually and the self-test as a whole", async (world) => {
  world.operator.stall("outbound.github-app");
  const result = await world.operator.selfTest({ worker: "github" });

  expect(result.ok).toBe(false);
  expect(result.check("outbound.github-app")).toMatchObject({ ok: false, detail: "timeout" });
  expect(result.check("outbound.github-app")!.ms).toBeLessThan(3_000);
  expect(result.checks.filter((check) => check.name !== "outbound.github-app").every((check) => check.ok)).toBe(true);
}, { needs: ["fakes"] });

scenario("IT-OPS-008 The self-test leaves no trace", async (world) => {
  const before = await world.storage.fingerprint();
  for (const worker of workersOf(world)) await world.operator.selfTest({ worker });
  expect(await world.storage.fingerprint()).toBe(before);
}, { needs: ["fakes", "storage"] });

scenario("IT-OPS-009 The self-test rate limit is per authenticated principal and cannot be spent by outsiders", async (world) => {
  const first = unique("first");
  const spent = await world.operator.drainSelfTestBudget({ principal: first });
  expect(spent.answered).toBe(10);
  await expect(spent.refusal).toBeRateLimited();
  await expect(world.operator.selfTest({ shallow: true, principal: first })).toBeRateLimited();

  const second = await world.operator.drainSelfTestBudget({ principal: unique("second") });
  expect(second.answered).toBe(10);

  for (let call = 0; call < 50; call++) await expect(world.visitor().selfTest()).toBeNotFound();
  const afterOutsiders = await world.operator.drainSelfTestBudget({ principal: unique("third") });
  expect(afterOutsiders.answered).toBe(10);

  await world.clock.advance("2m");
  expect((await world.operator.selfTest({ shallow: true, principal: first })).ok).toBe(true);
}, { needs: ["fakes", "clock"] });

scenario("IT-OPS-010 Shallow mode runs local checks and never calls out", async (world) => {
  world.operator.stall("outbound.github-app");
  for (const worker of workersOf(world)) {
    const shallow = await world.operator.selfTest({ worker, shallow: true });
    const names = shallow.checks.map((check) => check.name);
    expect(names).toEqual(expect.arrayContaining(["config.environment", "bindings.present", "secrets.SELFTEST_HMAC_KEY"]));
    expect(names.filter((name) => name.startsWith("outbound.") || name.startsWith("service."))).toEqual([]);
    expect(shallow.ok).toBe(true);
    expect(shallow.versionId).not.toBe("");
  }
  expect(world.github.apiCalls()).toEqual([]);

  const full = await world.operator.selfTest({ worker: "web" });
  expect(full.checks.map((check) => check.name)).toEqual(expect.arrayContaining(["service.mcp", "service.publish"]));
}, { needs: ["fakes"] });

scenario("IT-OPS-011 A schema outside the supported range fails the self-test", async (world) => {
  const { min, max } = world.database.supportedRange();
  const rangeText = `range=${min}..${max}`;
  const schemaCheck = async (worker: string) => (await world.operator.selfTest({ worker })).checks.find((check) => check.name.startsWith("d1.schema"));

  for (const worker of STORES) expect(await schemaCheck(worker)).toMatchObject({ name: "d1.schema", ok: true });

  const ahead = max + 1_000_000;
  await world.database.setMigrationHead(ahead);
  for (const worker of STORES) expect(await schemaCheck(worker)).toMatchObject({ name: "d1.schema", ok: true });

  const contract = ahead + 1_000_000;
  await world.database.setMigrationHead(contract, { kind: "contract" });
  for (const worker of STORES) {
    const result = await world.operator.selfTest({ worker });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name.startsWith("d1.schema"))).toMatchObject({ name: `d1.schema head=${contract} ${rangeText}`, ok: false });
  }

  const behind = min - 1;
  await world.database.setMigrationHead(behind);
  for (const worker of STORES) {
    const result = await world.operator.selfTest({ worker });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name.startsWith("d1.schema"))).toMatchObject({ ok: false });
    expect(result.checks.find((check) => check.name.startsWith("d1.schema"))!.name).toContain(rangeText);
  }
}, { needs: ["fakes", "storage"] });

scenario("JT-010 A release candidate proves itself on the canary host before traffic", async (world) => {
  for (const worker of workersOf(world)) {
    const full = await world.operator.selfTest({ worker });
    const shallow = await world.operator.selfTest({ worker, shallow: true });
    expect(full.ok).toBe(true);
    expect(shallow.ok).toBe(true);
    expect(full.releaseId).toBe(world.operator.deployedVersion());
    expect(shallow.versionId).toBe(full.versionId);
    expect(shallow.checks.map((check) => check.name)).toEqual(full.checks.map((check) => check.name).filter((name) => !name.startsWith("outbound.") && !name.startsWith("service.")));
    await expect(world.visitor().selfTest({ worker })).toBeNotFound();
  }
  expect([...world.operator.observedVersions()]).toEqual([world.operator.deployedVersion()]);

  const spent = await world.operator.drainSelfTestBudget({ principal: unique("release") });
  expect(spent.answered).toBeLessThanOrEqual(10);
  await expect(spent.refusal).toBeRateLimited();
}, { tags: ["probe-safe"] });
