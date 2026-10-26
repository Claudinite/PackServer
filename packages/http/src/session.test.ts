import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createSession, destroySession, issueGrant, type SessionPorts } from "@packserver/core/identity";
import { migratedD1 } from "@packserver/core/identity/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import {
  ASSERTION_HEADER, clearedSessionCookie, csrfTokenFor, requireAssertion, requireMfa, requireSession, resolveSession, sessionCaller, sessionCookie,
  sessionCsrf, SESSION_COOKIE, type SessionVariables,
} from "./index";

const ORIGIN = "https://registry.example";

async function setup() {
  const fakes = createFakePorts();
  const { d1, db } = migratedD1();
  for (const id of ["u1", "u2"]) db.exec(`insert into users (id, created_at) values ('${id}', '2026-10-22T00:00:00.000Z')`);
  const ports: SessionPorts = { kv: fakes.kv.SESSIONS_KV!, d1, clock: fakes.clock, rng: fakes.rng };
  const app = new Hono<{ Variables: SessionVariables }>();
  app.use(resolveSession(() => ports));
  app.get("/open", (c) => c.text(c.get("session") ? "signed-in" : "anonymous"));
  app.get("/private", requireSession(), (c) => c.text("private"));
  app.post("/form", sessionCsrf(() => ORIGIN), (c) => c.text(`caller:${sessionCaller(c)}`));
  app.post("/sensitive", requireAssertion("token.mint", { ports: () => ports }), (c) => c.text(`done:${c.get("assertion")?.user_id}`));
  app.post("/targeted", requireAssertion("token.mint", { ports: () => ports, target: (c) => c.req.query("pack") ?? "" }), (c) => c.text("done"));
  app.post("/publisher", requireMfa({ ports: () => ports }), (c) => c.text("publisher"));
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

describe("the per-action assertion check", () => {
  const ACTION = "token.mint";
  const grant = async (h: Awaited<ReturnType<typeof setup>>, over: Partial<{ sid_hash: string; action: string; target: string; user_id: string }> = {}) =>
    issueGrant(h.ports, { user_id: "u1", sid_hash: h.live.sid_hash, action: ACTION, target: "", ...over }, { method: "passkey", credential_id: null });
  const call = (h: Awaited<ReturnType<typeof setup>>, sid: string, token?: string, path = "/sensitive") =>
    h.app(path, { method: "POST", headers: { ...h.cookie(sid), ...(token ? { [ASSERTION_HEADER]: token } : {}) } });

  it("asks for step-up unless the request carries an assertion, and for sign-in unless it has a session", async () => {
    const h = await setup();
    expect(await (await call(h, h.live.sid)).json()).toMatchObject({ reason: "step-up" });
    expect(await (await call(h, h.live.sid, "not-a-grant")).json()).toMatchObject({ reason: "step-up" });
    expect((await h.app("/sensitive", { method: "POST" })).status).toBe(401);
  });

  it("accepts an assertion made by this session for this action once, and leaves the grant on the context", async () => {
    const h = await setup();
    const token = await grant(h);
    const first = await call(h, h.live.sid, token);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("done:u1");
    expect(await (await call(h, h.live.sid, token)).json()).toMatchObject({ reason: "step-up" });
  });

  it("refuses an assertion made for another action, target or session without spending it", async () => {
    const h = await setup();
    const wrongAction = await grant(h, { action: "yank" });
    const wrongTarget = await grant(h, { target: "pack-b" });
    const elsewhere = await grant(h, { sid_hash: h.other.sid_hash });
    for (const token of [wrongAction, wrongTarget, elsewhere]) expect((await call(h, h.live.sid, token)).status).toBe(403);
    expect((await call(h, h.other.sid, elsewhere)).status).toBe(403);
  });

  it("binds the target the route names", async () => {
    const h = await setup();
    const mine = await grant(h, { target: "pack-a" });
    expect((await call(h, h.live.sid, mine, "/targeted?pack=pack-b")).status).toBe(403);
    expect((await call(h, h.live.sid, mine, "/targeted?pack=pack-a")).status).toBe(200);
  });

  it("refuses a signed-out id while a store replica still serves it", async () => {
    const h = await setup();
    const token = await grant(h);
    const record = await h.fakes.kv.SESSIONS_KV!.get(`sess:${h.live.sid_hash}`);
    await destroySession(h.ports, h.live);
    await h.fakes.kv.SESSIONS_KV!.put(`sess:${h.live.sid_hash}`, record!, { ttl_seconds: 600 });
    expect((await call(h, h.live.sid, token)).status).toBe(401);
  });

  it("refuses everything while step-up is locked", async () => {
    const h = await setup();
    const token = await grant(h);
    await h.ports.d1.query("insert into assertion_failures (user_id, failures, window_started_at, locked_until) values ('u1', 5, ?, ?)", [
      new Date(h.fakes.clock.now()).toISOString(), new Date(h.fakes.clock.now() + 900_000).toISOString(),
    ]);
    const res = await call(h, h.live.sid, token);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
  });
});

describe("the MFA gate", () => {
  it("sends an account without a passkey to enrolment and lets one with a passkey through", async () => {
    const h = await setup();
    expect(await (await h.app("/publisher", { method: "POST", headers: h.cookie(h.live.sid) })).json()).toMatchObject({ reason: "mfa-required" });
    expect((await h.app("/publisher", { method: "POST" })).status).toBe(401);
    await h.ports.d1.query(
      "insert into credentials (id, user_id, credential_id, public_key, sign_count, created_at) values ('c1', 'u1', 'cred', 'key', 0, '2026-10-22T00:00:00.000Z')",
    );
    expect((await h.app("/publisher", { method: "POST", headers: h.cookie(h.live.sid) })).status).toBe(200);
    expect((await h.app("/publisher", { method: "POST", headers: h.cookie(h.other.sid) })).status).toBe(403);
  });
});
