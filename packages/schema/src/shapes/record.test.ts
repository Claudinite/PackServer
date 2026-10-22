import { describe, expect, it } from "vitest";
import { RECORDER_MODES, RecordEnvelope } from "./record";

const invocation = (seq: number, over: object = {}) => ({
  seq, parent: null, kind: "d1", target: "DB", op: "query", effect: "read",
  request: { sql: "select 1" }, request_hash: "h", result: [], result_hash: "h", ms: 1, executed: true,
  error: null, match: null, overlay: null, stub: null, ...over,
});
const envelope = {
  v: 1, request_id: "ray", side: "wet", worker: "web", version_id: "v", release_id: "r", mode: "wet",
  ts: "2026-10-22T10:00:00.000Z",
  request: { method: "GET", route: "/api/packs/:scope/:name", path_params: {}, query: {}, headers: {}, principal: { kind: "user", id_hash: "h" }, body_hash: null },
  response: { status: 200, headers: {}, body_hash: null, ms: 3, error: null },
  pins: { now: "2026-10-22T10:00:00.000Z", now_deltas: [], random: [], d1_bookmark: null },
  invocations: [invocation(0), invocation(1, { kind: "r2" })],
  outcome: "ok", truncated: false, redactions: [],
};

describe("record envelope", () => {
  it("has the two v1 modes", () => expect([...RECORDER_MODES]).toEqual(["off", "wet"]));
  it("accepts a wet record", () => expect(RecordEnvelope.safeParse(envelope).success).toBe(true));
  it("rejects version 2, a dry mode and an unknown invocation kind", () => {
    expect(RecordEnvelope.safeParse({ ...envelope, v: 2 }).success).toBe(false);
    expect(RecordEnvelope.safeParse({ ...envelope, mode: "dry-replay" }).success).toBe(false);
    expect(RecordEnvelope.safeParse({ ...envelope, invocations: [invocation(0, { kind: "smtp" })] }).success).toBe(false);
  });
  it("rejects invocations out of seq order", () => {
    expect(RecordEnvelope.safeParse({ ...envelope, invocations: [invocation(1), invocation(0)] }).success).toBe(false);
  });
  it("rejects dry-side fields set in wet mode", () => {
    expect(RecordEnvelope.safeParse({ ...envelope, invocations: [invocation(0, { stub: "x" })] }).success).toBe(false);
  });
  it("rejects an unknown effect and a record without redactions", () => {
    expect(RecordEnvelope.safeParse({ ...envelope, invocations: [invocation(0, { effect: "delete" })] }).success).toBe(false);
    expect(RecordEnvelope.safeParse({ ...envelope, redactions: undefined }).success).toBe(false);
  });
});
