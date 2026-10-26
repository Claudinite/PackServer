import { describe, expect, it } from "vitest";
import { assignShards } from "../sequencer";

describe("assignShards", () => {
  const weights = { a: 100, b: 60, c: 50, d: 40, e: 10 };

  it("places every file on exactly one shard", () => {
    const shards = assignShards(["a", "b", "c", "d", "e"], weights, 3);
    expect(shards.flat().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("balances load by weight, not by file count", () => {
    const loads = assignShards(["a", "b", "c", "d", "e"], weights, 3).map((s) => s.reduce((n, f) => n + weights[f as keyof typeof weights], 0));
    expect(Math.max(...loads)).toBe(100);
  });

  it("is independent of the order the files arrive in", () => {
    expect(assignShards(["e", "d", "c", "b", "a"], weights, 3)).toEqual(assignShards(["a", "b", "c", "d", "e"], weights, 3));
  });

  it("weighs a file with no recorded duration as the median one", () => {
    const shards = assignShards(["a", "b", "c", "d", "e", "new"], weights, 2);
    expect(shards.flat()).toContain("new");
  });
});
