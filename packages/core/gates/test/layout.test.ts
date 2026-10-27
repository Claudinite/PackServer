import { describe, expect, it } from "vitest";
import { GATE_RESULT_BLOBS, GATE_RESULT_DOUBLES, gateResultPoint, parseProbeAttrs, parseQueueAttrs, parseSelftestAttrs, type GateVerdict } from "../index";

const verdict: GateVerdict = {
  gate: "gate.availability", version_id: "v1", status: "pass", binding: true, samples: 300, floor: 300, observed: 0.002, threshold: 0.005,
  p_binomial: 0.4, p_fisher: null, decided_at: 300, reasons: [], evaluated_at: 1,
};

describe("the gate_results point", () => {
  it("indexes on the evaluated version and keeps an unknown as -1", () => {
    const point = gateResultPoint(verdict, { worker: "web", mode: "launch", source: "real" });
    expect(point).toMatchObject({ name: "gate.evaluated", index: "v1" });
    expect(point.blobs).toHaveLength(GATE_RESULT_BLOBS.length);
    expect(point.doubles).toHaveLength(GATE_RESULT_DOUBLES.length);
    expect(point.doubles[GATE_RESULT_DOUBLES.indexOf("p_fisher")]).toBe(-1);
    expect(point.doubles[GATE_RESULT_DOUBLES.indexOf("p_binomial")]).toBe(0.4);
  });

  it("keeps a real zero apart from an unknown", () => {
    const point = gateResultPoint({ ...verdict, observed: 0, p_fisher: 0 }, { worker: "web", mode: "launch", source: "real" });
    expect(point.doubles[GATE_RESULT_DOUBLES.indexOf("observed")]).toBe(0);
    expect(point.doubles[GATE_RESULT_DOUBLES.indexOf("p_fisher")]).toBe(0);
  });
});

describe("signal attribute readers", () => {
  it("read what the emitters write and nothing less", () => {
    expect(parseSelftestAttrs('{"ok":true}')).toEqual({ ok: true });
    expect(parseSelftestAttrs('{"ok":"yes"}')).toBeNull();
    expect(parseSelftestAttrs("nope")).toBeNull();
    expect(parseProbeAttrs('{"target":"v","run":"r","scenario":"s","ok":false,"stale_s":12}')).toEqual({ target: "v", run: "r", scenario: "s", ok: false, indexOk: null, staleS: 12 });
    expect(parseProbeAttrs('{"target":"v","run":"r","scenario":"s","ok":false,"stale_s":-1}')?.staleS).toBeNull();
    expect(parseProbeAttrs('{"target":"v","run":"r","scenario":"summary","ok":false,"index_ok":true,"failed":"selftest"}')).toMatchObject({ ok: false, indexOk: true });
    expect(parseProbeAttrs('{"target":"v","run":"r","scenario":"summary","ok":true,"index_ok":"yes"}')?.indexOk).toBeNull();
    expect(parseProbeAttrs('{"target":"v","ok":true}')).toBeNull();
    expect(parseQueueAttrs('{"queue":"audit"}')).toBe("audit");
    expect(parseQueueAttrs("[]")).toBeNull();
  });
});
