import { dummyEnv } from "@packserver/http/testing";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, type Env } from "../src/bindings";

describe("validator sandbox port", () => {
  it("says it is not wired when the product Containers are bound", () => {
    const { ports } = createRuntime(dummyEnv("validator", "production") as unknown as Env);
    expect(() => ports.sandbox.inspect({ upload: new Uint8Array(), request: {} })).toThrow("no production adapter");
  });

  it("sends inspect to the fake A Worker and run to the fake B Worker under env.test", async () => {
    const inspect = vi.fn(async () => ({ report: {}, canonical: null }));
    const run = vi.fn(async () => ({ report: {} }));
    const env = { ...dummyEnv("validator"), SANDBOX_A: { fetch: vi.fn(), inspect }, SANDBOX_B: { fetch: vi.fn(), run } };
    const { ports } = createRuntime(env as unknown as Env);
    await ports.sandbox.inspect({ upload: new Uint8Array(), request: {} });
    await ports.sandbox.run({ canonical: new Uint8Array(), request: {}, engines: [] });
    expect(inspect).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });
});
