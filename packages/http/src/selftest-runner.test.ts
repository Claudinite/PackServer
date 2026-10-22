import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "@packserver/ports/fakes";
import { runSelfTest, type SelfTestCheck } from "./index";

const fake = new FakeClock();
const clock = fake;
const advances = (ms: number): SelfTestCheck["run"] => async () => {
  fake.advance(ms);
  return true;
};
const run = (checks: SelfTestCheck[], shallow = false) =>
  runSelfTest({ versionId: "ver-1", releaseId: "rel-1", checks, shallow, clock });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("IT-OPS-005 self-test shape", () => {
  it("reports ids and checks, and ok exactly when every check is", async () => {
    const passing = await run([{ name: "a", run: async () => true }, { name: "b", run: async () => {} }]);
    expect(passing).toEqual({
      version_id: "ver-1",
      release_id: "rel-1",
      ok: true,
      checks: [
        { name: "a", ok: true, ms: 0, detail: "ok" },
        { name: "b", ok: true, ms: 0, detail: "ok" },
      ],
    });
    const failing = await run([
      { name: "a", run: async () => true },
      { name: "b", run: async () => false },
      { name: "c", run: async () => { throw new Error("secret-token-123"); } },
    ]);
    expect(failing.ok).toBe(false);
    expect(failing.checks.map((c) => c.detail)).toEqual(["ok", "failed", "error"]);
    expect(JSON.stringify(failing)).not.toContain("secret-token-123");
  });

  it("skips outbound.* and service.* checks when shallow and runs everything otherwise", async () => {
    const checks = ["config.secrets", "bindings.own", "outbound.github", "service.validator"].map((name) => ({ name, run: async () => true }));
    expect((await run(checks, true)).checks.map((c) => c.name)).toEqual(["config.secrets", "bindings.own"]);
    expect((await run(checks)).checks).toHaveLength(4);
  });
});

describe("IT-OPS-007 timeouts", () => {
  it("times out a hung check at 2 s while the others report", async () => {
    const pending = run([{ name: "hung", run: () => new Promise(() => {}) }, { name: "fine", run: advances(10) }]);
    await vi.advanceTimersByTimeAsync(2_010);
    const result = await pending;
    expect(result.checks.map((c) => [c.name, c.ok, c.detail])).toEqual([["hung", false, "timeout"], ["fine", true, "ok"]]);
  });

  it("marks a check that advances the injected clock past 2 s as timed out", async () => {
    const result = await run([{ name: "slow", run: advances(2_500) }, { name: "fine", run: advances(10) }]);
    expect(result.checks).toEqual([
      { name: "slow", ok: false, ms: 2_500, detail: "timeout" },
      { name: "fine", ok: true, ms: 10, detail: "ok" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("stops at 10 s of injected time: later checks report timeout without running", async () => {
    const ran: string[] = [];
    const checks = Array.from({ length: 8 }, (_, i) => ({
      name: `c${i}`,
      run: async () => {
        ran.push(`c${i}`);
        fake.advance(1_500);
        return true;
      },
    }));
    const result = await run(checks);
    expect(result.checks.slice(0, 6).every((c) => c.ok)).toBe(true);
    expect(result.checks[6]).toMatchObject({ ok: false, detail: "timeout" });
    expect(result.checks[7]).toMatchObject({ ok: false, ms: 0, detail: "timeout" });
    expect(ran).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
  });
});
