import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSelfTest, type SelfTestCheck } from "./index";

const clock = { now: () => Date.now() };
const sleeps = (ms: number): SelfTestCheck["run"] => () => new Promise((resolve) => setTimeout(() => resolve(true), ms));
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

  it("runs only the shallow checks when asked", async () => {
    const result = await run([{ name: "deep", run: async () => true }, { name: "own", shallow: true, run: async () => true }], true);
    expect(result.checks.map((c) => c.name)).toEqual(["own"]);
  });
});

describe("IT-OPS-007 timeouts", () => {
  it("times a hung check out at 2 s while the others report", async () => {
    const pending = run([{ name: "hung", run: () => new Promise(() => {}) }, { name: "fine", run: sleeps(10) }]);
    await vi.advanceTimersByTimeAsync(2_010);
    const result = await pending;
    expect(result.checks).toEqual([
      { name: "hung", ok: false, ms: 2_000, detail: "timeout" },
      { name: "fine", ok: true, ms: 10, detail: "ok" },
    ]);
  });

  it("answers within 10 s when every check takes 1.5 s, marking the overrunning ones timed out", async () => {
    const checks = Array.from({ length: 8 }, (_, i) => ({ name: `c${i}`, run: sleeps(1_500) }));
    const pending = run(checks);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.checks.slice(0, 6).every((c) => c.ok)).toBe(true);
    expect(result.checks[6]).toMatchObject({ ok: false, detail: "timeout" });
    expect(result.checks[7]).toMatchObject({ ok: false, ms: 0, detail: "timeout" });
    expect(result.ok).toBe(false);
  });
});
