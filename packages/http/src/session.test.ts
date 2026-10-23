import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createSession, destroySession, type SessionPorts } from "@packserver/core/identity";
import { migratedD1 } from "@packserver/core/identity/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import {
  ASSERTION_STUB_HEADER, clearedSessionCookie, csrfTokenFor, requireAssertion, requireSession, resolveSession, sessionCaller, sessionCookie,
  sessionCsrf, SESSION_COOKIE, type SessionVariables,
} from "./index";

const ORIGIN = "https://registry.example";

async function setup(environment = "test") {
  const fakes = createFakePorts();
  const { d1, db } = migratedD1();
  for (const id of ["u1", "u2"]) db.exec(`insert into users (id, created_at) values ('${id}', '2026-10-22T00:00:00.000Z')`);
  const ports: SessionPorts = { kv: fakes.kv.SESSIONS_KV!, d1, clock: fakes.clock, rng: fakes.rng };
  const app = new Hono<{ Variables: SessionVariables }>();
  app.use(resolveSession(() => ports));
  app.get("/open", (c) => c.text(c.get("session") ? "signed-in" : "anonymous"));
  app.get("/private", requireSession(), (c) => c.text("private"));
  app.post("/form", sessionCsrf(() => ORIGIN), (c) => c.text(`caller:${sessionCaller(c)}`));
  app.post("/sensitive", requireAssertion("token.mint", { ports: () => ports, environment: () => environment }), (c) => c.text("done"));
  const live = await createSession(ports, { user_id: "u1", device: { label: "Firefox on Linux", country: "NO" } });
  const other = await createSession(ports, { user_id: "u2", device: { label: "Firefox on Linux", country: "NO" } });
  const cookie = (sid: string) => ({ cookie: `${SESSION_COOKIE}=${sid}` });
  return { ports, app: (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init), fakes, live, other, cookie };
}

describe("session cookie", () => {
  it("is __Host- prefixed, Secure, HttpOnly, SameSite=Lax, host-only and bounded by the absolute limit", async () => {
    const { live, fakes } = await setup();
    const header = sessionCookie(live, fakes.clock.now());
    expect(header.startsWith(`__Host-session=${live.sid};`)).toBe(true);
    const attributes = header.split("; ").slice(1);
    expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]));
    expect(attributes.some((a) => /^Domain=/i.test(a))).toBe(false);
    expect(attributes).toContain(`Max-Age=${7 * 24 * 3600}`);
  });
});

describe("resolving and requiring a session", () => {
  it("reads the session from the cookie and turns away a request without one", async () => {
    const { app, live, cookie } = await setup();
    expect(await (await app("/open")).text()).toBe("anonymous");
    expect(await (await app("/open", { headers: cookie(live.sid) })).text()).toBe("signed-in");
    expect((await app("/private")).status).toBe(401);
    expect((await app("/private", { headers: cookie(live.sid) })).status).toBe(200);
  });

  it("clears a cookie that names no live session", async () => {
    const { app, cookie } = await setup();
    const res = await app("/open", { headers: cookie("x".repeat(64)) });
    expect(res.headers.get("set-cookie")).toBe(clearedSessionCookie);
  });
});

describe("IT-ABUSE-007 CSRF bound to the session", () => {
  const post = (h: Awaited<ReturnType<typeof setup>>, headers: Record<string, string>, token?: string) =>
    h.app("/form", { method: "POST", headers: { ...headers, ...(token ? { "x-csrf-token": token } : {}) } });

  it("accepts the session's own token from the site's own origin", async () => {
    const h = await setup();
    const res = await post(h, { ...h.cookie(h.live.sid), origin: ORIGIN }, await csrfTokenFor(h.live));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`caller:${h.live.sid_hash}`);
  });

  it("refuses no token, another session's token and a foreign origin", async () => {
    const h = await setup();
    const mine = { ...h.cookie(h.live.sid), origin: ORIGIN };
    expect((await post(h, mine)).status).toBe(403);
    expect((await post(h, mine, await csrfTokenFor(h.other))).status).toBe(403);
    expect((await post(h, { ...mine, origin: "https://evil.example" }, await csrfTokenFor(h.live))).status).toBe(403);
    expect((await post(h, { origin: ORIGIN }, await csrfTokenFor(h.live))).status).toBe(401);
  });

  it("stops accepting a token once the session rotated", async () => {
    const h = await setup();
    const { rotateSession } = await import("@packserver/core/identity");
    const rotated = await rotateSession(h.ports, h.live);
    const stale = await csrfTokenFor(h.live);
    expect((await post(h, { ...h.cookie(rotated.sid), origin: ORIGIN }, stale)).status).toBe(403);
    expect((await post(h, { ...h.cookie(rotated.sid), origin: ORIGIN }, await csrfTokenFor(rotated))).status).toBe(200);
  });
});

describe("the assertion stand-in", () => {
  it("asks for step-up unless the request names the action", async () => {
    const h = await setup();
    const call = (extra: Record<string, string>) => h.app("/sensitive", { method: "POST", headers: { ...h.cookie(h.live.sid), ...extra } });
    expect(await (await call({})).json()).toMatchObject({ reason: "step-up" });
    expect((await call({ [ASSERTION_STUB_HEADER]: "yank" })).status).toBe(403);
    expect((await call({ [ASSERTION_STUB_HEADER]: "token.mint" })).status).toBe(200);
    expect((await h.app("/sensitive", { method: "POST" })).status).toBe(401);
  });

  it("fails closed outside the test environment, whatever the request carries", async () => {
    for (const environment of ["production", "staging", ""]) {
      const h = await setup(environment);
      const res = await h.app("/sensitive", { method: "POST", headers: { ...h.cookie(h.live.sid), [ASSERTION_STUB_HEADER]: "token.mint" } });
      expect(res.status, environment).toBe(403);
      expect(await res.json(), environment).toMatchObject({ reason: "step-up" });
    }
  });

  it("refuses a signed-out id while a store replica still serves it", async () => {
    const h = await setup();
    const call = () => h.app("/sensitive", { method: "POST", headers: { ...h.cookie(h.live.sid), [ASSERTION_STUB_HEADER]: "token.mint" } });
    expect((await call()).status).toBe(200);
    const record = await h.fakes.kv.SESSIONS_KV!.get(`sess:${h.live.sid_hash}`);
    await destroySession(h.ports, h.live);
    await h.fakes.kv.SESSIONS_KV!.put(`sess:${h.live.sid_hash}`, record!, { ttl_seconds: 600 });
    expect((await call()).status).toBe(401);
  });
});
