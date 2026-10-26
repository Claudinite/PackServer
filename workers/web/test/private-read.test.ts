import { oidcConfig } from "@packserver/core/publishing";
import { TelemetrySink } from "@packserver/core/telemetry/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";

vi.mock("../src/routes/private/caller", () => ({
  resolveCaller: async () => ({ caller: { kind: "oidc", ownerId: "1001", repository: "alice/app", visibility: "private" } }),
}));

const ARCHIVE = new TextEncoder().encode("the bytes the validator stored");
const hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const VERSION = "0f0f0f0f-0000-4000-8000-000000000001";

async function setup(o: { state?: string; readable?: boolean; stored?: Uint8Array | null; failLog?: boolean; hold?: boolean } = {}) {
  const sink = new TelemetrySink();
  const fakes = createFakePorts({ worker: "web" });
  fakes.d1.on(/from effective_access/, () => ({ rows: o.readable === false ? [] : [{ id: "p1", scope: "acme", name: "secret" }] }));
  const gate = { release: () => {}, held: Promise.resolve() };
  if (o.hold) gate.held = new Promise<void>((resolve) => (gate.release = resolve));
  fakes.d1.on(/fetch_log/, () => {
    if (o.failLog) throw new Error("d1 is down");
    return {};
  });
  if (o.hold) {
    const query = fakes.d1.query.bind(fakes.d1);
    fakes.d1.query = async (sql, params) => (/fetch_log/.test(sql) ? gate.held.then(() => query(sql, params)) : query(sql, params));
  }
  const sha = await hex(ARCHIVE);
  fakes.d1.on(/from pack_versions v join packs p/, (params) =>
    params[0] === VERSION ? { rows: [{ state: o.state ?? "active", sha256: sha, version: "1.0.0", pack_id: "p1", name: "secret", scope: "acme" }] } : { rows: [] },
  );
  if (o.stored !== null) await fakes.r2.PACKS_PRIVATE?.put(`v/${VERSION}/pack.tar.zst`, o.stored ?? ARCHIVE);
  const runtime: WebRuntime = {
    worker: "web", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: { ...fakes, stats: sink, githubLogin: {} as never }, services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { oidc: oidcConfig({ ENVIRONMENT: "production" }), fetch, cdnOrigin: undefined, siteOrigins: ["https://registry.test.invalid"] },
  };
  const pending: Array<Promise<unknown>> = [];
  const app = createApp(runtime);
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as never;
  const get = async (id: string) => {
    const res = await app.request(`/api/private/v/${id}`, {}, undefined, ctx);
    await Promise.all(pending);
    return res;
  };
  const getWithoutSettling = (id: string) => app.request(`/api/private/v/${id}`, {}, undefined, ctx);
  return { get, getWithoutSettling, sink, fakes, pending, gate, app, calls: () => pending.length };
}

describe("GET /api/private/v/:versionId", () => {
  it("answers bytes that do not match the version's sha256 with 503, no bytes, and the hash_mismatch signal", async () => {
    const { get, sink } = await setup({ stored: new TextEncoder().encode("tampered") });
    const res = await get(VERSION);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).not.toContain("tampered");
    expect(sink.recorded("download.hash_mismatch")).toHaveLength(1);
    expect(sink.recorded("download.served")).toHaveLength(0);
  });

  it("serves the bytes when they match", async () => {
    const { get, sink } = await setup();
    const res = await get(VERSION);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ARCHIVE);
    expect(sink.recorded("download.hash_mismatch")).toHaveLength(0);
  });

  it("answers a removed version 410 with no bytes", async () => {
    const { get } = await setup({ state: "removed" });
    const res = await get(VERSION);
    expect(res.status).toBe(410);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers a denied id as it answers an unknown one, and logs the denial", async () => {
    const denied = await setup({ readable: false });
    const unknown = await setup();
    const a = await denied.get(VERSION);
    const b = await unknown.get("0f0f0f0f-0000-4000-8000-0000000000ff");
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
    const logged = (s: Awaited<ReturnType<typeof setup>>) => s.fakes.d1.executed.filter((e) => /insert into fetch_log/.test(e.sql)).length;
    expect(logged(denied)).toBe(1);
    expect(logged(unknown)).toBe(0);
  });

  it("hands the log write to waitUntil: the response returns while the write is still unresolved", async () => {
    for (const readable of [true, false]) {
      const t = await setup({ hold: true, readable });
      const res = await t.getWithoutSettling(readable ? VERSION : "0f0f0f0f-0000-4000-8000-0000000000ff");
      expect(res.status).toBe(readable ? 200 : 404);
      const inserted = () => t.fakes.d1.executed.filter((e) => /insert into fetch_log/.test(e.sql)).length;
      expect(inserted()).toBe(0);
      if (readable) {
        expect(t.pending.length).toBeGreaterThan(0);
        t.gate.release();
        await Promise.all(t.pending);
        expect(inserted()).toBe(1);
      }
    }
    const denied = await setup({ hold: true, readable: false });
    const res = await denied.getWithoutSettling(VERSION);
    expect(res.status).toBe(404);
    expect(denied.pending).toHaveLength(2);
    denied.gate.release();
    await Promise.all(denied.pending);
    expect(denied.fakes.d1.executed.filter((e) => /insert into fetch_log/.test(e.sql))).toHaveLength(1);
  });

  it("still serves the read when the log write fails, and reports the failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = await setup({ failLog: true });
      const res = await t.get(VERSION);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(ARCHIVE);
      expect(errors.mock.calls.some(([line]) => String(line).includes("private.fetch_log_failed"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});
