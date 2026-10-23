import { dummyEnv } from "@packserver/http/testing";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, type Env } from "../src/bindings";

describe("validator sandbox port", () => {
  it("says it is not wired when the product Containers are bound", () => {
    const { ports } = createRuntime(dummyEnv("validator", "production") as unknown as Env);
    expect(() => ports.sandbox.inspect({ archive_key: "k" })).toThrow("no production adapter");
  });

  it("sends inspect to the fake A Worker and run to the fake B Worker under env.test", async () => {
    const inspect = vi.fn(async () => ({ tree_hash: "t", canonical_key: "c", file_count: 1, findings: [] }));
    const run = vi.fn(async () => ({ loaded: true, round_trip_ok: true, checks: [], egress_attempts: [], findings: [] }));
    const env = { ...dummyEnv("validator"), SANDBOX_A: { fetch: vi.fn(), inspect }, SANDBOX_B: { fetch: vi.fn(), run } };
    const { ports } = createRuntime(env as unknown as Env);
    await ports.sandbox.inspect({ archive_key: "k" });
    await ports.sandbox.run({ canonical_key: "c", tree_hash: "t" });
    expect(inspect).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });
});
