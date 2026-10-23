import { dummyEnv } from "@packserver/http/testing";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, type Env } from "../src/bindings";

describe("mcp adapts both shapes of Vectorize and Workers AI behind one port", () => {
  it("uses the product bindings in staging and production", async () => {
    const env = {
      ...dummyEnv("mcp", "production"),
      VECTORIZE: { query: async () => ({ matches: [{ id: "a", score: 0.5, metadata: { k: 1 } }] }) },
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    };
    const { ports } = createRuntime(env as unknown as Env);
    expect(await ports.vectors.query([1], { topK: 1 })).toEqual([{ id: "a", score: 0.5, metadata: { k: 1 } }]);
    expect(await ports.embedder.embed(["x"])).toEqual([[0.1, 0.2]]);
  });

  it("uses the fake Worker's RPC under env.test", async () => {
    const query = vi.fn(async () => [{ id: "b", score: 1, metadata: {} }]);
    const embed = vi.fn(async () => [[0.3]]);
    const env = { ...dummyEnv("mcp"), VECTORIZE: { fetch: vi.fn(), query }, AI: { fetch: vi.fn(), embed } };
    const { ports } = createRuntime(env as unknown as Env);
    expect(await ports.vectors.query([1], { topK: 2 })).toEqual([{ id: "b", score: 1, metadata: {} }]);
    expect(query).toHaveBeenCalledWith([1], { topK: 2 });
    expect(await ports.embedder.embed(["y"])).toEqual([[0.3]]);
    expect(ports.embedder.model).toBe("@cf/baai/bge-m3");
  });
});
