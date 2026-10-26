import { CANDIDATE_MIRROR_KEY } from "@packserver/ports";
import { TELEMETRY_MODE_KEY } from "@packserver/core/telemetry";
import { describe, expect, it } from "vitest";
import { LAUNCH_FLAG_KEY } from "../src/gates/release";
import { runScheduled, type ScheduledDeps } from "../src/gates/scheduled";
import { signalEmitter } from "../src/heartbeat/emit";
import { FakeAdmin, FakeGateData, group, judgeFakes } from "./support";

function setup(patch: Partial<ScheduledDeps> = {}) {
  const fakes = judgeFakes();
  const data = new FakeGateData();
  const admin = new FakeAdmin();
  const telemetryKv = fakes.kv["TELEMETRY_KV"] as NonNullable<(typeof fakes.kv)[string]>;
  const deps: ScheduledDeps = {
    clock: fakes.clock,
    gatesKv: fakes.kv["GATES_KV"] as NonNullable<(typeof fakes.kv)[string]>,
    telemetryKv,
    data,
    stats: fakes.stats,
    admin,
    emit: signalEmitter({ releaseId: "rel", versionId: "judge-1", clock: fakes.clock, stats: fakes.stats, telemetry: fakes.telemetry }),
    ciTokenIds: [],
    dailyLogAllowance: 1000,
    ...patch,
  };
  const signals = (name: string) => fakes.stats.points.filter((p) => p.name === name);
  return { fakes, data, admin, telemetryKv, deps, signals };
}

const rolling = JSON.stringify({ release_id: "r1", state: "rolling", workers: { web: { version_id: "web-new", changed: true } } });

describe("the cron", () => {
  it("runs every fifth minute without a rollout and every minute during one", async () => {
    const { fakes, telemetryKv, deps, signals } = setup();
    fakes.clock.advance("1m");
    expect((await runScheduled(deps)).ran).toBe(false);
    expect(signals("monitoring.heartbeat")).toHaveLength(0);
    await telemetryKv.put(CANDIDATE_MIRROR_KEY, rolling);
    expect((await runScheduled(deps)).ran).toBe(true);
    fakes.clock.advance("4m");
    await telemetryKv.delete(CANDIDATE_MIRROR_KEY);
    expect((await runScheduled(deps)).ran).toBe(true);
    expect(signals("monitoring.heartbeat")).toHaveLength(2);
  });

  it("emits the heartbeat with the cycle's counts", async () => {
    const { data, deps, signals } = setup();
    data.groups = [group("web-new", "web", 400)];
    await runScheduled(deps);
    const [beat] = signals("monitoring.heartbeat");
    expect(beat?.blobs[0]).toBe("judge");
    expect(JSON.parse(beat?.blobs[3] ?? "{}")).toMatchObject({ ran: true, mode: "pre-launch", versions: 1, failures: 0, telemetry_mode: "normal" });
  });

  it("reads launch mode from the mirrored flag", async () => {
    const { data, telemetryKv, deps } = setup();
    data.groups = [group("web-new", "web", 400)];
    await telemetryKv.put(LAUNCH_FLAG_KEY, "true");
    expect((await runScheduled(deps)).cycle?.versions).toBe(1);
    const report = JSON.parse((await deps.gatesKv.get("gates/web-new")) ?? "{}");
    expect(report.mode).toBe("launch");
  });
});

describe("the telemetry_mode flip", () => {
  it("asks the admin API for economy once the day's allowance is spent, and for normal when it is under half", async () => {
    const { data, admin, telemetryKv, deps } = setup();
    data.groups = [group("web-new", "web", 1200, 0, { today: 1200 })];
    await runScheduled(deps);
    expect(admin.calls).toEqual([{ method: "set_telemetry_mode", mode: "economy" }]);

    await telemetryKv.put(TELEMETRY_MODE_KEY, "economy");
    data.groups = [group("web-new", "web", 700, 0, { today: 700 })];
    await runScheduled(deps);
    expect(admin.calls).toHaveLength(1);

    data.groups = [group("web-new", "web", 400, 0, { today: 400 })];
    await runScheduled(deps);
    expect(admin.calls[1]).toEqual({ method: "set_telemetry_mode", mode: "normal" });
  });

  it("never writes the switch itself", async () => {
    const { data, telemetryKv, deps } = setup();
    data.groups = [group("web-new", "web", 5000, 0, { today: 5000 })];
    await runScheduled(deps);
    expect(await telemetryKv.get(TELEMETRY_MODE_KEY)).toBeNull();
  });
});

describe("a failing step", () => {
  it("still sends the heartbeat and then fails the invocation", async () => {
    const { data, deps, signals } = setup();
    data.requestOutcomes = async () => {
      throw new Error("analytics engine answered 500");
    };
    await expect(runScheduled(deps)).rejects.toThrow(/1 judge steps failed/);
    expect(JSON.parse(signals("monitoring.heartbeat")[0]?.blobs[3] ?? "{}")).toMatchObject({ failures: 1, versions: 0, telemetry_mode: "unknown" });
  });

  it("does not default an allowance that was never set", async () => {
    const { data, admin, deps } = setup({ dailyLogAllowance: Number.NaN });
    data.groups = [group("web-new", "web", 5000, 0, { today: 5000 })];
    await expect(runScheduled(deps)).rejects.toThrow();
    expect(admin.calls).toEqual([]);
  });

  it("surfaces a refusal from the admin API", async () => {
    const { data, admin, deps } = setup();
    admin.refuse = true;
    data.groups = [group("web-new", "web", 5000, 0, { today: 5000 })];
    await expect(runScheduled(deps)).rejects.toThrow();
  });
});
