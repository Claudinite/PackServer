import { describe, expect, it } from "vitest";
import { createFakePorts } from "../fakes";
import { bindingNames, TRUST_TABLE, WORKER_NAMES } from "./trust-table";

describe("trust table", () => {
  it("names the eight Workers", () => {
    expect(WORKER_NAMES).toEqual(["web", "mcp", "publish", "github", "validator", "admin", "judge", "prober"]);
  });

  it("lets only the validator write the public and private buckets", () => {
    const writers = WORKER_NAMES.filter((w) =>
      Object.values(TRUST_TABLE[w].r2).some((b) => ["packs-public", "packs-private"].includes(b.bucket) && b.access !== "read"),
    );
    expect(writers).toEqual(["validator"]);
  });

  it("gives each Worker's fakes the Worker's real binding names", () => {
    const fakes = createFakePorts({ worker: "validator" });
    expect(Object.keys(fakes.r2).sort()).toEqual(Object.keys(TRUST_TABLE.validator.r2).sort());
    expect(Object.keys(fakes.kv)).toEqual([]);
    expect(Object.keys(fakes.queues)).toEqual(["NOTIFY_QUEUE"]);
    expect(Object.keys(fakes.rateLimits)).toEqual([]);
  });

  it("gives fakes with no Worker the names of every Worker", () => {
    const fakes = createFakePorts();
    expect(Object.keys(fakes.kv).sort()).toEqual(bindingNames("kv").sort());
    expect(Object.keys(fakes.kv).sort()).toEqual(["CACHE_KV", "GATES_KV", "OAUTH_KV", "SESSIONS_KV"]);
    expect(Object.keys(fakes.rateLimits)).toEqual(["RATE_LIMIT"]);
  });
});
