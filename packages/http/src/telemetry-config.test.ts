import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "@packserver/ports/fakes";
import { createIsolateTelemetry } from "./telemetry-config";

const sources = (over: Partial<{ ipMaster: () => Promise<string>; principalKey: () => Promise<string>; get: () => Promise<string | null> }> = {}) => {
  const calls = { ipMaster: 0, principalKey: 0, mode: 0 };
  return {
    calls,
    value: {
      ipMaster: over.ipMaster ?? (async () => (calls.ipMaster++, "ip-master")),
      principalKey: over.principalKey ?? (async () => (calls.principalKey++, "principal-key")),
      kv: { get: over.get ?? (async () => (calls.mode++, "economy")) },
    },
  };
};

describe("isolate telemetry config", () => {
  it("reads each secret once per isolate, however many requests ask", async () => {
    const isolate = createIsolateTelemetry();
    const s = sources();
    const clock = new FakeClock();
    for (let i = 0; i < 3; i++) expect(await isolate.config(s.value, clock).keys()).toEqual({ ipMaster: "ip-master", principalKey: "principal-key" });
    expect(s.calls).toMatchObject({ ipMaster: 1, principalKey: 1 });
  });

  it("reads telemetry_mode once per isolate per minute and parses it", async () => {
    const isolate = createIsolateTelemetry();
    const s = sources();
    const clock = new FakeClock();
    expect(await isolate.config(s.value, clock).mode()).toBe("economy");
    expect(await isolate.config(s.value, clock).mode()).toBe("economy");
    expect(s.calls.mode).toBe(1);
    clock.advance("61s");
    await isolate.config(s.value, clock).mode();
    expect(s.calls.mode).toBe(2);
  });

  it("falls back to normal for an unset or unknown flag", async () => {
    const clock = new FakeClock();
    expect(await createIsolateTelemetry().config(sources({ get: async () => null }).value, clock).mode()).toBe("normal");
    expect(await createIsolateTelemetry().config(sources({ get: async () => "debug" }).value, clock).mode()).toBe("normal");
  });

  it("leaves an unreadable secret out, keeps the other, and retries the first on the next request", async () => {
    const isolate = createIsolateTelemetry();
    let attempts = 0;
    const s = sources({ ipMaster: async () => { if (attempts++ === 0) throw new Error("store down"); return "ip-master"; } });
    const config = isolate.config(s.value, new FakeClock());
    expect(await config.keys()).toEqual({ principalKey: "principal-key" });
    expect(await config.keys()).toEqual({ ipMaster: "ip-master", principalKey: "principal-key" });
  });

  it("reports an unreadable secret, scrubbed, at most once per minute per key", async () => {
    const isolate = createIsolateTelemetry();
    const reports: { key: string; message: string }[] = [];
    const s = sources({ ipMaster: async () => { throw new Error("store down for 10.0.0.1"); } });
    const clock = new FakeClock();
    const config = isolate.config(s.value, clock, (key, message) => reports.push({ key, message }));
    await config.keys();
    await config.keys();
    expect(reports).toEqual([{ key: "ipMaster", message: "store down for [ip]" }]);
    clock.advance("61s");
    await config.keys();
    expect(reports).toHaveLength(2);
  });

  it("writes telemetry.keys_unavailable to the console by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = createIsolateTelemetry().config(sources({ principalKey: async () => { throw new Error("no such secret"); } }).value, new FakeClock());
      expect(await config.keys()).toEqual({ ipMaster: "ip-master" });
      expect(spy).toHaveBeenCalledWith('{"event":"telemetry.keys_unavailable","key":"principalKey","message":"no such secret"}');
    } finally {
      spy.mockRestore();
    }
  });

  it("treats an empty secret as unreadable: reported, left out, and read again", async () => {
    const isolate = createIsolateTelemetry();
    const reports: string[] = [];
    let value = "";
    const s = sources({ ipMaster: async () => value });
    const config = isolate.config(s.value, new FakeClock(), (key) => reports.push(key));
    expect(await config.keys()).toEqual({ principalKey: "principal-key" });
    expect(reports).toEqual(["ipMaster"]);
    value = "ip-master";
    expect(await config.keys()).toEqual({ ipMaster: "ip-master", principalKey: "principal-key" });
  });
});
