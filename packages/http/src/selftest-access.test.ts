import { signSelfTest } from "@packserver/core/selftest";
import { FakeAccessIdentity, FakeClock } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createShell, SelfTestMemory, selfTestAccess, type SelfTestRuntime } from "./index";

const KEY = "shared-key";
const NOW = Date.parse("2026-10-26T12:00:00Z");
const wallClock = { now: () => NOW };
const access = new FakeAccessIdentity();

function worldOf(overrides: Partial<SelfTestRuntime["ports"]> = {}, key: SelfTestRuntime["selfTestKey"] | "none" = async () => KEY) {
  const clock = new FakeClock(NOW);
  const memory = new SelfTestMemory();
  const runtime: SelfTestRuntime = { worker: "web", version: { versionId: "v1", releaseId: "r1" }, selfTestKey: key === "none" ? undefined : key, ports: { clock, access, ...overrides } };
  const app = createShell({
    worker: "web", releaseId: "r1", versionId: "v1", clock,
    checks: () => [{ name: "config.environment", run: async () => true }],
    selfTest: selfTestAccess(runtime, { memory, wallClock }),
  });
  return { app, clock, memory };
}

let counter = 0;
const signed = async (path = "/__selftest", over: { keyId?: string; nonce?: string; key?: string; nowMs?: number } = {}) =>
  new Request(`https://registry.test${path}`, {
    headers: { "X-Selftest-Signature": await signSelfTest({ key: over.key ?? KEY, keyId: over.keyId ?? "1", method: "GET", path, nowMs: over.nowMs ?? NOW, nonce: over.nonce ?? `nonce-${++counter}` }) },
  });
const statusOf = async (app: { fetch(r: Request): Response | Promise<Response> }, request: Request) => (await app.fetch(request)).status;

describe("IT-OPS-004 who reaches the self-test", () => {
  it("answers a signed request and an Access assertion, and nobody else, as an unknown path", async () => {
      const { app } = worldOf();
      expect(await statusOf(app, await signed())).toBe(200);
      const assertion = await access.assert({ email: "svc@access.test", sub: "service-token-1" });
      expect(await statusOf(app, new Request("https://registry.test/__selftest", { headers: { "cf-access-jwt-assertion": assertion } }))).toBe(200);
      const unknown = await app.fetch(new Request("https://registry.test/nowhere"));
      for (const request of [
        new Request("https://registry.test/__selftest"),
        await signed("/__selftest", { key: "wrong" }),
        await signed("/__selftest", { nowMs: NOW - 400_000 }),
        new Request("https://registry.test/__selftest", { headers: { "cf-access-jwt-assertion": "forged|token|sig" } }),
        new Request("https://registry.test/__selftest", { headers: { "X-Selftest-Signature": "t=1, n=a, k=1" } }),
      ]) {
        const res = await app.fetch(request);
        expect([res.status, await res.text()]).toEqual([unknown.status, "Not Found"]);
      }
  });

  it("is closed when the Worker holds no key and no Access port", async () => {
      const { app } = worldOf({ access: undefined }, "none");
      expect(await statusOf(app, await signed())).toBe(404);
  });

  it("serves the path signed for, and the signature does not carry over to another path", async () => {
      const { app } = worldOf();
      const request = await signed("/web/__selftest");
      expect(await statusOf(app, request)).toBe(200);
      const elsewhere = new Request("https://registry.test/__selftest", { headers: request.headers });
      expect(await statusOf(app, elsewhere)).toBe(404);
  });

  it("refuses a nonce it has already seen", async () => {
      const { app } = worldOf();
      expect(await statusOf(app, await signed("/__selftest", { nonce: "same-nonce" }))).toBe(200);
      expect(await statusOf(app, await signed("/__selftest", { nonce: "same-nonce" }))).toBe(404);
  });
});

describe("IT-OPS-009 rate limit per principal", () => {
  it("refuses the eleventh in a minute, leaves other principals alone and recovers with the window", async () => {
      const { app, clock } = worldOf();
      for (let call = 0; call < 10; call++) expect(await statusOf(app, await signed("/__selftest", { keyId: "a" }))).toBe(200);
      const refused = await app.fetch(await signed("/__selftest", { keyId: "a" }));
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ reason: "rate-limited" });
      expect(await statusOf(app, await signed("/__selftest", { keyId: "b" }))).toBe(200);
      clock.advance(61_000);
      expect(await statusOf(app, await signed("/__selftest", { keyId: "a" }))).toBe(200);
  });

  it("spends nothing on anonymous or forged calls", async () => {
      const { app } = worldOf();
      for (let call = 0; call < 50; call++) expect(await statusOf(app, new Request("https://registry.test/__selftest"))).toBe(404);
      for (let call = 0; call < 12; call++) expect(await statusOf(app, await signed("/__selftest", { key: "wrong", keyId: "a" }))).toBe(404);
      for (let call = 0; call < 10; call++) expect(await statusOf(app, await signed("/__selftest", { keyId: "a" }))).toBe(200);
  });

  it("counts an Access principal by its subject", async () => {
      const { app } = worldOf();
      const assertion = await access.assert({ email: "svc@access.test", sub: "svc-2" });
      const call = () => statusOf(app, new Request("https://registry.test/__selftest", { headers: { "cf-access-jwt-assertion": assertion } }));
      for (let n = 0; n < 10; n++) expect(await call()).toBe(200);
      expect(await call()).toBe(429);
  });
});

describe("candidate gating", () => {
  const manifest = (over: object = {}) => new TextEncoder().encode(JSON.stringify({ state: "verifying", workers: { web: { changed: true, version_id: "v1" } }, ...over }));
  const gatedWorld = (read: (id: string) => Promise<Uint8Array | null>) => {
    const clock = new FakeClock(NOW);
    const memory = new SelfTestMemory();
    const runtime: SelfTestRuntime = { worker: "web", version: { versionId: "v1", releaseId: `r-${++counter}` }, selfTestKey: async () => KEY, ports: { clock } };
    const app = createShell({
      worker: "web", releaseId: runtime.version.releaseId, versionId: "v1", clock, checks: () => [],
      selfTest: selfTestAccess(runtime, { memory, wallClock, readManifest: read }),
    });
    app.get("/page", (c) => c.text("hello"));
    return { app, clock };
  };

  it("answers an unsigned request as an unknown path while the version is the candidate in verifying, and a signed one normally", async () => {
      const { app } = gatedWorld(async () => manifest());
      const unknown = await app.fetch(new Request("https://registry.test/nowhere"));
      const unsigned = await app.fetch(new Request("https://registry.test/page"));
      expect([unsigned.status, await unsigned.text()]).toEqual([404, "Not Found"]);
      expect(unsigned.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
      expect(await statusOf(app, await signed("/page"))).toBe(200);
  });

  it("serves everyone once the release has moved past verifying, or when the version is not the candidate", async () => {
      for (const body of [manifest({ state: "rolling" }), manifest({ workers: { web: { changed: true, version_id: "other" } } }), manifest({ workers: { web: { changed: false, version_id: "v1" } } })]) {
        const { app } = gatedWorld(async () => body);
        expect(await statusOf(app, new Request("https://registry.test/page"))).toBe(200);
      }
  });

  it("fails open when the manifest read fails, is missing or is not a manifest", async () => {
      for (const read of [async () => { throw new Error("r2 down"); }, async () => null, async () => new TextEncoder().encode("not json")]) {
        const { app } = gatedWorld(read);
        expect(await statusOf(app, new Request("https://registry.test/page"))).toBe(200);
      }
  });

  it("reads the manifest once for a burst and again after it expires", async () => {
      let reads = 0;
      const { app, clock } = gatedWorld(async () => (reads++, manifest()));
      for (let n = 0; n < 5; n++) await app.fetch(new Request("https://registry.test/page"));
      expect(reads).toBe(1);
      clock.advance(11_000);
      await app.fetch(new Request("https://registry.test/page"));
      expect(reads).toBe(2);
  });

  it("lets the gated candidate be released by the next manifest", async () => {
      let current = manifest();
      const { app, clock } = gatedWorld(async () => current);
      expect(await statusOf(app, new Request("https://registry.test/page"))).toBe(404);
      current = manifest({ state: "rolling" });
      clock.advance(11_000);
      expect(await statusOf(app, new Request("https://registry.test/page"))).toBe(200);
  });

  it("uses a signature once for the gate and the self-test together", async () => {
      const { app } = gatedWorld(async () => manifest());
      expect(await statusOf(app, await signed("/__selftest"))).toBe(200);
  });
});

