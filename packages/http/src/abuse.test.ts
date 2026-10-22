import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { createFakePorts, FakeRateLimit, TURNSTILE_PASS_TOKEN } from "@packserver/ports/fakes";
import { csrf, csrfToken, idempotency, rateLimit, turnstile, type TurnstileVariables } from "./index";

const ORIGIN = "https://registry.example";
const SECRET = "test-secret";

function formApp() {
  const ports = createFakePorts();
  const created: string[] = [];
  const app = new Hono();
  app.use(
    csrf({ secret: SECRET, allowedOrigins: [ORIGIN], sessionId: (c) => c.req.header("x-session") }),
    idempotency({ kv: ports.kv.sessions!, caller: (c) => c.req.header("x-session") }),
  );
  app.post("/review", async (c) => {
    created.push((await c.req.parseBody()).text as string);
    return c.json({ id: created.length }, 201);
  });
  return { app, created };
}

async function post(app: Hono, init: { session?: string; token?: string; origin?: string; key?: string; body?: string }) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (init.session) headers["x-session"] = init.session;
  if (init.origin) headers.origin = init.origin;
  if (init.key) headers["idempotency-key"] = init.key;
  const body = new URLSearchParams({ text: init.body ?? "great" });
  if (init.token) body.set("csrf", init.token);
  return app.request("/review", { method: "POST", headers, body });
}

describe("IT-ABUSE-007 CSRF and idempotency", () => {
  it("refuses a missing token, another session's token and a foreign origin", async () => {
    const { app, created } = formApp();
    const good = await csrfToken(SECRET, "s1");
    const key = "key-00000001";
    expect((await post(app, { session: "s1", origin: ORIGIN, key })).status).toBe(403);
    expect((await post(app, { session: "s1", origin: ORIGIN, key, token: await csrfToken(SECRET, "s2") })).status).toBe(403);
    expect((await post(app, { session: "s1", origin: "https://evil.example", key, token: good })).status).toBe(403);
    expect((await post(app, { origin: ORIGIN, key, token: good })).status).toBe(401);
    expect(created).toEqual([]);
  });

  it("applies a replayed key once and returns the first response", async () => {
    const { app, created } = formApp();
    const init = { session: "s1", origin: ORIGIN, key: "key-00000002", token: await csrfToken(SECRET, "s1") };
    const first = await post(app, init);
    const second = await post(app, init);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ id: 1 });
    expect(created).toEqual(["great"]);
  });

  it("requires a well-formed key and keeps callers apart", async () => {
    const { app, created } = formApp();
    const token = await csrfToken(SECRET, "s1");
    expect((await post(app, { session: "s1", origin: ORIGIN, token })).status).toBe(400);
    expect((await post(app, { session: "s1", origin: ORIGIN, token, key: "short" })).status).toBe(400);
    await post(app, { session: "s1", origin: ORIGIN, token, key: "key-00000003" });
    await post(app, { session: "s2", origin: ORIGIN, token: await csrfToken(SECRET, "s2"), key: "key-00000003" });
    expect(created).toHaveLength(2);
  });

  it("lets safe methods through untouched", async () => {
    const { app } = formApp();
    app.get("/page", (c) => c.text("page"));
    expect((await app.request("/page")).status).toBe(200);
  });
});

describe("idempotency details", () => {
  function app2(caller: (c: Context) => string | undefined = (c) => c.req.header("x-session")) {
    const ports = createFakePorts();
    const app = new Hono();
    const runs: string[] = [];
    app.use(idempotency({ kv: ports.kv.sessions!, caller }));
    app.post("/x", async (c) => {
      const status = Number(c.req.header("x-status") ?? 201);
      runs.push(String(status));
      return c.json({ n: runs.length }, status as 201);
    });
    const send = (headers: Record<string, string>, body = "a=1") =>
      app.request("/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
    return { send, runs, ports };
  }
  const h = (extra: Record<string, string> = {}) => ({ "x-session": "s1", "idempotency-key": "key-0000000A", ...extra });

  it("lets a retry run fresh after any outcome other than 2xx/3xx", async () => {
    for (const status of [400, 403, 429, 500]) {
      const { send, runs } = app2();
      await send(h({ "x-status": String(status) }));
      const retry = await send(h());
      expect(retry.headers.get("idempotent-replay")).toBeNull();
      expect(runs).toEqual([String(status), "201"]);
    }
  });

  it("stores and replays a 2xx", async () => {
    const { send, runs } = app2();
    await send(h());
    const replay = await send(h());
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(runs).toHaveLength(1);
  });

  it("neither stores nor replays for an anonymous caller", async () => {
    const { send, runs, ports } = app2();
    const anon = { "idempotency-key": "key-0000000A" };
    await send(anon);
    const second = await send(anon);
    expect(second.headers.get("idempotent-replay")).toBeNull();
    expect(runs).toHaveLength(2);
    expect(await ports.kv.sessions!.list("idem:")).toEqual([]);
  });

  it("gives the in-progress marker a short TTL and the result a long one", async () => {
    const { send, ports } = app2();
    const kv = ports.kv.sessions!;
    const put = kv.put.bind(kv);
    const ttls: Array<[string, number | undefined]> = [];
    kv.put = async (k, v, o) => {
      ttls.push([v === "pending" ? "pending" : "result", o?.ttl_seconds]);
      return put(k, v, o);
    };
    await send(h());
    expect(ttls.find(([k]) => k === "pending")?.[1]).toBe(60);
    expect(ttls.find(([k]) => k === "result")?.[1]).toBe(86_400);
  });

  it("accepts the key from a form field", async () => {
    const { send, runs } = app2();
    await send({ "x-session": "s1" }, "idempotency-key=key-0000000F&a=1");
    const replay = await send({ "x-session": "s1" }, "idempotency-key=key-0000000F&a=1");
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(runs).toHaveLength(1);
  });

  it("refuses a different body under the same key", async () => {
    const { send, runs } = app2();
    await send(h(), "a=1");
    const clash = await send(h(), "a=2");
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ reason: "exists" });
    expect(runs).toHaveLength(1);
  });

  it("refuses a body over 64 KiB before parsing", async () => {
    const { send, runs } = app2();
    const res = await send(h(), "a=" + "x".repeat(70_000));
    expect(res.status).toBe(413);
    expect(runs).toHaveLength(0);
  });
});

describe("rate limit wrapper", () => {
  it("refuses after the limit with a rate-limited body and leaves other keys alone", async () => {
    const ports = createFakePorts();
    const app = new Hono();
    app.use(rateLimit({ limiter: new FakeRateLimit(ports.clock, 2, 60_000), key: (c) => c.req.header("cf-connecting-ip") ?? "x" }));
    app.get("/", (c) => c.text("ok"));
    const hit = (ip: string) => app.request("/", { headers: { "cf-connecting-ip": ip } });
    expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(200);
    const refused = await hit("1.1.1.1");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: "rate-limited" });
    expect((await hit("2.2.2.2")).status).toBe(200);
  });
});

describe("IT-ABUSE-002 Turnstile middleware", () => {
  function setup(withFallback: boolean) {
    const ports = createFakePorts();
    const effects: string[] = [];
    const app = new Hono<{ Variables: TurnstileVariables }>();
    app.use(
      turnstile({
        verifier: ports.turnstile,
        ...(withFallback ? { fallbackLimiter: new FakeRateLimit(ports.clock, 1, 60_000) } : {}),
      }),
    );
    app.post("/signup", (c) => {
      effects.push("landed");
      return c.json({ humanCheck: c.get("humanCheck") });
    });
    const submit = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
      app.request("/signup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(fields),
      });
    return { submit, effects, ports };
  }

  it("refuses a failing or absent token with no effect and lets a passing one land", async () => {
    const { submit, effects } = setup(true);
    for (const res of [await submit({ "cf-turnstile-response": "nope" }), await submit({})]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: "human-check" });
    }
    expect(effects).toEqual([]);
    const ok = await submit({ "cf-turnstile-response": TURNSTILE_PASS_TOKEN });
    expect(await ok.json()).toEqual({ humanCheck: "passed" });
  });

  it("falls back to a stricter limit when the widget failed to load", async () => {
    const { submit } = setup(true);
    const unavailable = { "turnstile-unavailable": "1" };
    expect((await submit(unavailable)).status).toBe(200);
    const second = await submit(unavailable, { "cf-connecting-ip": "9.9.9.9" });
    expect((await second.json()) as unknown).toMatchObject({ humanCheck: "fallback" });
    const third = await submit({}, { "x-turnstile-unavailable": "1" });
    expect(third.status).toBe(429);
  });

  it("does not trust the unavailable claim when no fallback limiter is configured", async () => {
    const { submit } = setup(false);
    expect((await submit({ "turnstile-unavailable": "1" })).status).toBe(403);
  });

  it("treats an unreachable verifier as unavailable", async () => {
    const { submit, ports } = setup(true);
    ports.turnstile.verify = async () => {
      throw new Error("siteverify down");
    };
    const res = await submit({ "cf-turnstile-response": TURNSTILE_PASS_TOKEN });
    expect(await res.json()).toEqual({ humanCheck: "fallback" });
  });
});
