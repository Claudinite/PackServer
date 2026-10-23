import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createHasher, createModeCache, createTelemetry } from "@packserver/core/telemetry";
import { TelemetrySink, toHaveRecorded } from "@packserver/core/telemetry/testing";
import { baseSecurityHeaders } from "@packserver/ui/headers";
import { FakeClock } from "@packserver/ports/fakes";
import { AFFINITY_HEADER, recorder, requestTelemetry, VERSION_OVERRIDE_HEADER } from "./recorder-middleware";
import { createShell } from "./worker-shell";

expect.extend({ toHaveRecorded });

const KEYS = { ipMaster: "m", principalKey: "p" };
const IP = "198.51.100.77";

function build(options: { mode?: () => Promise<"normal" | "economy">; random?: () => number } = {}) {
  const clock = new FakeClock();
  const sink = new TelemetrySink();
  const order: string[] = [];
  const app = new Hono();
  app.use(
    recorder({
      clock,
      mode: options.mode,
      random: options.random ?? (() => 0),
      telemetry: createTelemetry({ worker: "web", releaseId: "rel-1", versionId: "ver-1", stats: { write: (p) => (order.push(p.name), sink.write(p)) }, clock, hasher: createHasher(KEYS, clock), log: sink.log }),
    }),
  );
  app.get("/api/packs/:id", (c) => {
    requestTelemetry(c).set({ visibility: "public", journey: "adopt", pack: "@acme/x", scope: "@acme", principal: { kind: "session", id: "u1" }, timings: { d1_ms: 9 } });
    requestTelemetry(c).emit("search.query", { pack: "@acme/x" });
    order.push("handler");
    return c.json({ ok: true });
  });
  app.get("/boom", () => {
    throw new Error("secret detail");
  });
  app.get("/private/:versionId", (c) => {
    const t = requestTelemetry(c);
    t.set({ visibility: "private", pack: "@acme/hidden", scope: "@acme", principal: { kind: "oidc", id: "4242" } });
    t.download({
      visibility: "private", pack: "@acme/hidden", version: "1.0.0", versionId: c.req.param("versionId"), fetcher: "cn_update",
      principal: { kind: "oidc", id: "4242" }, ip: c.req.header("cf-connecting-ip"), userAgent: c.req.header("user-agent"),
      repository: { ownerId: "4242", name: "acme/app" }, affinityKey: c.req.header(AFFINITY_HEADER),
    });
    return new Response("bytes");
  });
  return { app, sink, order };
}

const get = (app: Hono, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { "cf-connecting-ip": IP, "user-agent": "cn/1.4.2", ...headers } }, undefined, { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as never);
const pending: Promise<unknown>[] = [];
const settle = async () => {
  await Promise.all(pending.splice(0));
};

describe("recorder middleware", () => {
  it("IT-TELEM-001 writes the wide event and the queued domain events after the handler, through waitUntil", async () => {
    const { app, sink, order } = build();
    const res = await get(app, "/api/packs/abc");
    expect(res.status).toBe(200);
    expect(sink.points).toEqual([]);
    await settle();
    expect(order).toEqual(["handler", "http.request", "search.query"]);
    expect(sink).toHaveRecorded("http.request", { worker: "web", "http.route": "/api/packs/:id", status: 200, outcome: "ok", journey: "adopt", pack: "@acme/x", principal_kind: "session", client_version: "1.4.2", d1_ms: 9 });
    expect(sink.recorded("http.request")[0]!.fields.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.recorded("http.request")[0]!.fields.principal_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.logged()[0]).toMatchObject({ event: "http.request", status: 200 });
  });

  it("IT-TELEM-006 never stores the address, and the route is the pattern rather than the path", async () => {
    const { app, sink } = build();
    await get(app, "/api/packs/abc");
    await get(app, "/no/such/path");
    await settle();
    expect(sink.everything()).not.toContain(IP);
    expect(sink.everything()).not.toContain("abc");
    expect(sink).toHaveRecorded("http.request", { "http.route": "unmatched", status: 404, outcome: "client_error", principal_kind: "anonymous" });
  });

  it("records an exception without its message and still answers", async () => {
    const { app, sink } = build();
    const res = await get(app, "/boom");
    await settle();
    expect(res.status).toBe(500);
    expect(sink).toHaveRecorded("http.request", { status: 500, outcome: "exception" });
    expect(sink.everything()).not.toContain("secret detail");
  });

  it("flags a version override from the request header", async () => {
    const { app, sink } = build();
    await get(app, "/api/packs/abc", { [VERSION_OVERRIDE_HEADER]: 'web="ver-2"' });
    await get(app, "/api/packs/abc");
    await settle();
    // Each request records on its own schedule, so the two events arrive in either order.
    expect(sink.recorded("http.request").map((r) => r.fields.version_override === true).sort()).toEqual([false, true]);
  });

  it("applies telemetry_mode: economy drops an anonymous line, never the point", async () => {
    const { app, sink } = build({ mode: async () => "economy" });
    await get(app, "/no/such/path");
    await settle();
    expect(sink.lines).toEqual([]);
    expect(sink.recorded("http.request")).toHaveLength(1);
  });

  it("reads the mode through the per-isolate cache once for many requests", async () => {
    const cache = createModeCache(new FakeClock());
    let reads = 0;
    const { app } = build({ mode: () => cache.get(async () => (reads++, "normal")) });
    for (let i = 0; i < 5; i++) await get(app, "/api/packs/abc");
    await settle();
    expect(reads).toBe(1);
  });

  it("IT-TELEM-008 a private fetch records the repository in downloads only, not in the wide event", async () => {
    const { app, sink } = build();
    await get(app, "/private/opaque-id", { [AFFINITY_HEADER]: "feedfacefeedfacefeedfacefeedface" });
    await settle();
    expect(sink).toHaveRecorded("download.served", { repository: "acme/app", repository_owner_id: "4242", fetcher: "cn_update" });
    const wide = JSON.stringify(sink.points.filter((p) => p.name === "http.request")) + sink.lines.join("");
    expect(wide).not.toContain("acme/app");
    expect(wide).not.toContain("@acme/hidden");
    expect(wide).not.toContain("feedface");
    expect(sink.everything()).not.toContain("feedfacefeedface");
  });

  it("a failing sink never fails the response", async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const app = new Hono();
    app.use(recorder({ clock, onError: (e) => errors.push(e), telemetry: createTelemetry({ worker: "web", releaseId: "r", versionId: "v", stats: { write: () => { throw new Error("ae down"); } }, clock, hasher: createHasher({}, clock) }) }));
    app.get("/", (c) => c.text("hi"));
    const res = await app.request("/", {}, undefined, { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as never);
    await settle();
    expect(res.status).toBe(200);
    expect(errors).toHaveLength(1);
  });

  it("works without an execution context", async () => {
    const { app, sink } = build();
    const res = await app.request("/api/packs/abc");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.recorded("http.request")).toHaveLength(1);
  });
});

describe("recorder isolation", () => {
  it("a failing wide event does not drop the queued download or domain events", async () => {
    const clock = new FakeClock();
    const sink = new TelemetrySink();
    const errors: unknown[] = [];
    const app = new Hono();
    app.use(recorder({ clock, onError: (e) => errors.push(e), telemetry: createTelemetry({ worker: "web", releaseId: "r", versionId: "v", stats: { write: (p) => { if (p.name === "http.request") throw new Error("boom 10.0.0.1"); sink.write(p); } }, clock, hasher: createHasher({}, clock) }) }));
    app.get("/", (c) => { requestTelemetry(c).emit("auth.login", { a: 1 }); return c.text("hi"); });
    const res = await app.request("/", {}, undefined, { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as never);
    await settle();
    expect(res.status).toBe(200);
    expect(sink).toHaveRecorded("auth.login");
    expect(errors).toHaveLength(1);
  });

  it("the default error handler logs a scrubbed message", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l: string) => void lines.push(l);
    try {
      const clock = new FakeClock();
      const app = new Hono();
      app.use(recorder({ clock, telemetry: createTelemetry({ worker: "web", releaseId: "r", versionId: "v", stats: { write: () => { throw new Error("from 10.0.0.1"); } }, clock, hasher: createHasher({}, clock) }) }));
      app.get("/", (c) => c.text("hi"));
      await app.request("/");
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.error = orig;
    }
    expect(lines.join("")).toContain("[ip]");
    expect(lines.join("")).not.toContain("10.0.0.1");
  });
});

describe("createShell security headers", () => {
  it("sets them on handler, error, not-found and self-test responses alike", async () => {
    const shell = createShell({ worker: "web", releaseId: "rel-1", versionId: "ver-1", clock: new FakeClock(), checks: () => [], selfTestAllowed: () => true });
    shell.get("/page", (c) => c.html("<p>hi</p>"));
    shell.get("/data", (c) => c.json({ ok: true }));
    shell.get("/boom", () => {
      throw new Error("x");
    });
    for (const path of ["/page", "/data", "/boom", "/missing", "/__selftest"]) {
      const res = await shell.request(path);
      for (const [name, value] of Object.entries(baseSecurityHeaders)) expect(res.headers.get(name), `${path} ${name}`).toBe(value);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("default-src 'none'");
      expect(csp.includes("nonce-"), path).toBe(path === "/page");
    }
  });
});

describe("createShell with stats", () => {
  it("records every request, the version header response included, and still answers without stats", async () => {
    const clock = new FakeClock();
    const sink = new TelemetrySink();
    const shell = (stats?: TelemetrySink) => createShell({ worker: "web", releaseId: "rel-1", versionId: "ver-1", clock, checks: () => [], stats });
    const withStats = shell(sink);
    const res = await withStats.request("/nope", {}, undefined, { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as never);
    await settle();
    expect(res.headers.get("X-PackServer-Version")).toBe("rel-1");
    expect(sink).toHaveRecorded("http.request", { worker: "web", status: 404, release_id: "rel-1" });
    expect(sink.recorded("http.request")[0]!.fields).not.toHaveProperty("ip_hash");
    expect((await shell().request("/nope")).status).toBe(404);
  });
});
