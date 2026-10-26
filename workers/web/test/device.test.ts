import { csrfTokenFor } from "@packserver/http";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts, FakeRateLimit } from "@packserver/ports/fakes";
import { migratedD1 } from "@packserver/core/identity/testing";
import { createSession, DEVICE_GRANT_TYPE, type SessionPorts } from "@packserver/core/identity";
import { inbox } from "@packserver/core/mail/testing";

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";

const ORIGIN = "https://registry.example";

function setup() {
  const fakes = createFakePorts({ worker: "web" });
  const { d1, db } = migratedD1();
  const runtime: WebRuntime = {
    worker: "web",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...fakes, d1, rateLimits: { RATE_LIMIT: new FakeRateLimit(fakes.clock, 60, 60_000) }, githubLogin: {} as never },
    services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { cdnOrigin: undefined, siteOrigins: [ORIGIN] },
  };
  const app = createApp(runtime);
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  const sessionPorts: SessionPorts = { kv: fakes.kv.SESSIONS_KV!, d1, clock: fakes.clock, rng: fakes.rng };
  const personAt = async (id: string, ip: string) => {
    db.exec(`insert into users (id, created_at) values ('${id}', '2026-10-22T00:00:00.000Z')`);
    db.exec(`insert into user_emails (user_id, address, source, created_at) values ('${id}', '${id}@example.test', 'github', '2026-10-22T00:00:00.000Z')`);
    const live = await createSession(sessionPorts, { user_id: id, device: { label: "Firefox on Linux", country: "NO" } });
    const csrf = await csrfTokenFor(live);
    return (path: string, fields: Record<string, string>) =>
      post(path, fields, { origin: ORIGIN, cookie: `__Host-session=${live.sid}`, "x-csrf-token": csrf, "cf-connecting-ip": ip });
  };
  const ask = async () => (await (await post("/api/auth/device", {})).json()) as { device_code: string; user_code: string };
  return { app, post, fakes, personAt, ask };
}

describe("IT-PRIV-017 device code endpoints", () => {
  it("answers the first leg per RFC 8628 without a link that carries the code", async () => {
    const { post } = setup();
    const res = await post("/api/auth/device", { client_id: "cn" }, { "cf-ipcountry": "SE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["device_code", "expires_in", "interval", "user_code", "verification_uri"]);
    expect(String(body.verification_uri)).not.toContain(String(body.user_code));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports polling errors as OAuth errors", async () => {
    const { post } = setup();
    const started = (await (await post("/api/auth/device", {})).json()) as { device_code: string };
    const poll = async (fields: Record<string, string>) => {
      const res = await post("/api/auth/device/token", fields);
      return [res.status, ((await res.json()) as { error: string }).error] as const;
    };
    expect(await poll({ grant_type: "password", device_code: started.device_code })).toEqual([400, "unsupported_grant_type"]);
    expect(await poll({ grant_type: DEVICE_GRANT_TYPE })).toEqual([400, "invalid_request"]);
    expect(await poll({ grant_type: DEVICE_GRANT_TYPE, device_code: "nope" })).toEqual([400, "invalid_grant"]);
    expect(await poll({ grant_type: DEVICE_GRANT_TYPE, device_code: started.device_code })).toEqual([400, "authorization_pending"]);
  });

  it("answers a device token check only for a token it issued", async () => {
    const { app } = setup();
    for (const authorization of [undefined, "Bearer nope", `Bearer psr_${"1".repeat(64)}`]) {
      const res = await app.request(`${ORIGIN}/api/auth/device/grant`, { headers: authorization ? { authorization } : {} });
      expect(res.status).toBe(401);
    }
  });

  it("does not take a code from someone who is not signed in", async () => {
    const { app, post } = setup();
    const page = await app.request(`${ORIGIN}/api/auth/device/verify`);
    expect(await page.text()).toContain("Sign in");
    for (const path of ["/api/auth/device/verify", "/api/auth/device/decision"]) {
      const res = await post(path, { user_code: "BCDF-GHJK", decision: "approve" }, { origin: ORIGIN });
      expect(res.status).toBe(401);
    }
  });

  it("emails every verified address when a device is approved,", async () => {
    const { personAt, ask, fakes } = setup();
    const ann = await personAt("ann", "198.51.100.1");
    const code = await ask();
    expect((await ann("/api/auth/device/decision", { user_code: code.user_code, decision: "approve" })).status).toBe(200);
    const mails = inbox(fakes.mail, "ann@example.test");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("New sign-in");
  });

  it("spends the account's budget on decisions as on lookups", async () => {
    const { personAt, ask } = setup();
    const ann = await personAt("ann", "198.51.100.1");
    const code = await ask();
    let refused = 0;
    for (let i = 0; i < 12; i++) if ((await ann("/api/auth/device/decision", { user_code: code.user_code, decision: "deny" })).status === 429) refused++;
    expect(refused).toBeGreaterThan(0);
  });

  it("spends the address's budget across accounts on both lookups and decisions", async () => {
    for (const path of ["/api/auth/device/verify", "/api/auth/device/decision"]) {
      const { personAt } = setup();
      const ann = await personAt("ann", "198.51.100.1");
      const bea = await personAt("bea", "198.51.100.1");
      for (let i = 0; i < 10; i++) await ann(path, { user_code: "BCDF-GHJK", decision: "deny" });
      expect((await bea(path, { user_code: "BCDF-GHJK", decision: "deny" })).status, path).toBe(429);
    }
  });
});
