import { RecordEnvelope } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { createFakePorts, FakeClock, FakeKV, type FakePorts } from "../fakes";
import { BINDING_SPECS, instrumentAll, PORT_SPECS } from "./instrument";
import { createRecorder, type FinishInput } from "./recorder";

const context = { request_id: "ray-1", side: "live", worker: "publish", version_id: "v1", release_id: "r1" };
const keys = { redaction: "redaction-key", principal: "principal-key" };

function wet(clock = new FakeClock(), lines: string[] = []) {
  return { recorder: createRecorder({ mode: "wet", context, clock, keys, sink: (l) => void lines.push(l) }), lines, clock };
}

const finishInput = (over: Partial<FinishInput["request"]> = {}, body?: unknown): FinishInput => ({
  request: {
    method: "POST",
    route: "/api/publish/:id",
    pathParams: { id: "opaque-id" },
    query: new URLSearchParams("z=1&a=2"),
    headers: { Authorization: "Bearer topsecret", "Content-Type": "application/json", "User-Agent": "cn/1.0" },
    principal: { kind: "user", id: "user-42" },
    body,
    ...over,
  },
  response: { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": "s=1" }, ms: 12, error: null },
  outcome: "ok",
});

describe("Recorder modes", () => {
  it("records nothing in off and passes calls straight through", async () => {
    const lines: string[] = [];
    const r = createRecorder({ mode: "off", context, clock: new FakeClock(), sink: (l) => void lines.push(l) });
    expect(await r.invoke({ kind: "kv", target: "kv", op: "get", effect: "read", request: {} }, () => Promise.resolve(5))).toBe(5);
    expect(await r.finish(finishInput())).toBeNull();
    expect(lines).toEqual([]);
  });

  it.each(["dry-replay", "dry-live"])("refuses the reserved mode %s", (mode) => {
    expect(() => createRecorder({ mode: mode as "off", context, clock: new FakeClock() })).toThrow("reserved");
  });

  it("refuses a wet recorder without keys", () => {
    expect(() => createRecorder({ mode: "wet", context, clock: new FakeClock() })).toThrow("keys");
  });
});

describe("Recorder envelope", () => {
  it("writes one schema-valid JSON line with allowlisted headers, sorted query and a hashed principal", async () => {
    const { recorder, lines } = wet();
    const envelope = await recorder.finish(finishInput());
    expect(lines).toHaveLength(1);
    expect(RecordEnvelope.parse(JSON.parse(lines[0] as string))).toEqual(envelope);
    expect(Object.keys(envelope!.request.query)).toEqual(["a", "z"]);
    expect(envelope!.request.headers).toEqual({ "content-type": "application/json", "user-agent": "cn" });
    expect(envelope!.response.headers).toEqual({ "content-type": "application/json" });
    expect(envelope!.request.principal?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[0]).not.toMatch(/topsecret|user-42|Bearer/);
  });

  it("records invocations in seq order with pins from the clock and rng reads", async () => {
    const ports = createFakePorts();
    const { recorder, clock } = wet(ports.clock);
    const p = instrumentAll(ports, recorder);
    const t0 = p.clock.now();
    clock.advance(250);
    p.clock.now();
    p.rng.float();
    await p.kv["SESSIONS_KV"]!.put("k", "v");
    const envelope = (await recorder.finish(finishInput()))!;
    expect(envelope.invocations.map((i) => i.seq)).toEqual([0, 1, 2, 3]);
    expect(envelope.invocations.map((i) => i.kind)).toEqual(["clock", "clock", "random", "kv"]);
    expect(envelope.pins.now_deltas).toEqual([0, 250]);
    expect(envelope.pins.random).toHaveLength(1);
    expect(envelope.pins.now).toBe(new Date(t0).toISOString());
  });

  it("rethrows a failing call and records the error as name and message hash only", async () => {
    const { recorder } = wet();
    await expect(
      recorder.invoke({ kind: "kv", target: "kv", op: "get", effect: "read", request: { args: [] }, rules: { "request.args": "operational" } }, () => Promise.reject(new TypeError("boom for user@example.com"))),
    ).rejects.toThrow("boom");
    const inv = (await recorder.finish(finishInput()))!.invocations[0]!;
    expect(inv.error).toEqual({ name: "TypeError", message_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(inv)).not.toContain("user@example.com");
  });

  it("keeps a body over 8 KB as a hash and marks the record truncated", async () => {
    const { recorder } = wet();
    const e = (await recorder.finish(finishInput({}, Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, "v"])))))!;
    expect(e.request.body).toBeUndefined();
    expect(e.request.body_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.truncated).toBe(true);
  });

  it("keys a non-JSON body by HMAC, never by a bare hash of its bytes", async () => {
    const a = (await wet().recorder.finish(finishInput({ rawBody: "same bytes" })))!;
    const b = await createRecorder({ mode: "wet", context, clock: new FakeClock(), keys: { ...keys, redaction: "other" } }).finish(
      finishInput({ rawBody: "same bytes" }),
    );
    expect(a.request.body_hash).not.toBe(b!.request.body_hash);
  });

  it("hashes the same request the same way on every side", async () => {
    const run = async () => {
      const { recorder } = wet();
      await recorder.invoke(
        { kind: "kv", target: "kv", op: "get", effect: "read", request: { args: ["k"] }, rules: { "request.args.0": "operational", result: "operational" } },
        () => Promise.resolve("v"),
      );
      return (await recorder.finish(finishInput()))!.invocations[0]!.request_hash;
    };
    expect(await run()).toBe(await run());
  });
});

describe("D1 invocations", () => {
  async function runQuery(sql: string, rows: Array<Record<string, unknown>>) {
    const ports = createFakePorts();
    ports.d1.on(/./, () => ({ rows }));
    const { recorder } = wet(ports.clock);
    await instrumentAll(ports, recorder).d1.query(sql, ["p1"]);
    return (await recorder.finish(finishInput()))!;
  }

  it("normalises the SQL, extracts tables and sorts rows when there is no ORDER BY", async () => {
    const e = await runQuery("SELECT  id FROM  packs", [{ id: 2 }, { id: 1 }]);
    const inv = e.invocations[0]!;
    expect(inv.effect).toBe("read");
    expect(inv.unordered).toBe(true);
    expect(inv.row_count).toBe(2);
    expect(inv.request).toMatchObject({ sql: "select id from packs", tables: ["packs"] });
    const again = await runQuery("select id from packs", [{ id: 1 }, { id: 2 }]);
    expect(again.invocations[0]!.result_hash).toBe(inv.result_hash);
  });

  it("keeps row order under ORDER BY and classifies a write", async () => {
    const e = await runQuery("select id from packs order by id", [{ id: 1 }]);
    expect(e.invocations[0]!.unordered).toBeUndefined();
    const w = await runQuery("delete from packs where id = ?", []);
    expect(w.invocations[0]!.effect).toBe("write");
  });

  it("hashes only a result over 50 rows and keeps the row count", async () => {
    const e = await runQuery("select id from packs", Array.from({ length: 51 }, (_, id) => ({ id })));
    const inv = e.invocations[0]!;
    expect(inv.result).toBeUndefined();
    expect(inv.row_count).toBe(51);
    expect(inv.result_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.truncated).toBe(true);
  });
});

describe("redaction (REQ-OPS-012)", () => {
  const marker = "MARKER-pack-text-7f3a";
  const email = "member@example.com";
  const token = "ghp_supersecrettoken";

  async function publishFlow(extraBody: Record<string, unknown> = {}) {
    const ports = createFakePorts();
    ports.d1.on(/./, () => ({ rows: [{ owner: email, text: marker }] }));
    const { recorder, lines } = wet(ports.clock);
    const p = instrumentAll(ports, recorder);
    await p.d1.query("select owner, text from packs where owner = ?", [email]);
    await p.mail.send({ to: email, subject: marker, text: `${marker} ${token}` });
    await p.turnstile.verify(token, "198.51.100.7");
    await p.queues["NOTIFY_QUEUE"]!.send({ email, marker });
    const envelope = (await recorder.finish(finishInput({}, { email, token, text: marker, ...extraBody })))!;
    return { envelope, lines, recorder, ports };
  }

  it("holds the email only as a personal placeholder, the marker only as customer-content and never the token", async () => {
    const { envelope, lines } = await publishFlow();
    const text = lines.join("\n");
    expect(text).not.toContain(email);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(token);
    expect(text).not.toContain("198.51.100.7");
    expect(text).toMatch(/<personal:[0-9a-f]{16}>/);
    expect(text).toMatch(/<customer-content:[0-9a-f]{16}>/);
    expect(envelope.request.body).toEqual({
      email: expect.stringMatching(/^<personal:/),
      text: expect.stringMatching(/^<customer-content:/),
    });
    expect(envelope.redactions).toEqual(expect.arrayContaining(["request.body.email", "request.body.token", "request.body.text"]));
  });

  it("treats a field the fixture leaves unclassified as customer-content and reports it", async () => {
    const { envelope, recorder } = await publishFlow({ surprise: "visible?" });
    expect(JSON.stringify(envelope)).not.toContain("visible?");
    expect(recorder.unclassifiedPaths()).toContain("request.body.surprise");
  });

  it("gives the same email the same placeholder in the envelope and in the invocations", async () => {
    const { envelope } = await publishFlow();
    const body = envelope.request.body as { email: string };
    expect(JSON.stringify(envelope.invocations.find((i) => i.kind === "http" && i.op === "send"))).toContain(body.email);
  });

  it("hashes invocation requests after redaction so a hash never confirms a raw value", async () => {
    const a = await publishFlow();
    const sendA = a.envelope.invocations.find((i) => i.op === "send")!;
    expect(JSON.stringify(sendA.request)).not.toContain(email);
  });
});

describe("recorded fakes", () => {
  it("rejects a method no spec classifies", () => {
    const { recorder } = wet();
    const stray = Object.assign(Object.create(new FakeKV(new FakeClock())) as object, { mystery: async () => 1 });
    const ports = createFakePorts();
    const wrapped = instrumentAll({ ...ports, kv: { SESSIONS_KV: stray as never } }, recorder);
    expect(() => (wrapped.kv["SESSIONS_KV"] as unknown as { mystery(): unknown }).mystery()).toThrow("no recorder classification");
  });
});

describe("port inventory", () => {
  const methodsOf = (o: object) =>
    Object.getOwnPropertyNames(Object.getPrototypeOf(o) as object).filter((n) => n !== "constructor" && typeof (o as never)[n] === "function");

  it("classifies exactly the public methods each fake exposes", () => {
    const ports = createFakePorts() as unknown as Record<string, object | Record<string, object>>;
    const one = (name: string, spec: { methods: object }, port: object) => {
      const portMethods = methodsOf(port).filter((m) => Object.keys(spec.methods).includes(m));
      expect(Object.keys(spec.methods).sort(), name).toEqual(portMethods.sort());
    };
    for (const [name, spec] of Object.entries(PORT_SPECS)) one(name, spec, ports[name] as object);
    for (const [name, spec] of Object.entries(BINDING_SPECS)) one(name, spec, Object.values(ports[name] as Record<string, object>)[0]!);
  });

  it("leaves no field unclassified when every port is called with sample data", async () => {
    const ports: FakePorts = createFakePorts();
    ports.d1.on(/./, () => ({ rows: [{ id: 1 }], meta: { changes: 1, last_row_id: 3 } }));
    ports.durableObjects.register("Quota", "n", { peek: () => ({ schema_version: 1, count: 0 }) });
    ports.github.repos.set("a/b", { slug: "a/b", id: 1, default_branch: "main", private: false, archived: false });
    ports.sandbox.scriptInspect(() => ({ report: { outcome: "ok" }, canonical: new Uint8Array([1]) }));
    ports.sandbox.scriptRun(() => ({ report: { outcome: "ok" } }));
    const { recorder } = wet(ports.clock);
    const p = instrumentAll(ports, recorder);
    const token = ports.oidc.mint({ aud: "packserver" });
    const assertion = await ports.access.assert({ email: "a@b.example", sub: "s" });
    p.clock.now(); p.rng.float(); p.rng.uuid(); p.rng.bytes(4);
    await p.github.getRepo("a/b"); await p.github.getRef("a/b", "main"); await p.github.getTree("a/b", "sha");
    await p.github.getBlob("a/b", "sha"); await p.github.getFile("a/b", "main", "x"); await p.github.searchCode("q");
    await p.oidc.verify(token, { audience: "packserver" });
    await p.vectors.upsert([{ id: "1", vector: [1, 0], metadata: { scope: "a" } }]);
    await p.vectors.query([1, 0], { topK: 1 }); await p.vectors.deleteByIds(["1"]);
    await p.embedder.embed(["text"]);
    await p.sandbox.inspect({ upload: new Uint8Array([1]), request: { pack: "@a/b" } });
    await p.sandbox.run({ canonical: new Uint8Array([1]), request: { pack: "@a/b" }, engines: [{ file: "1.0.0.tgz", bytes: new Uint8Array([2]) }] });
    await p.proseScreen.screen({ nonce: "n", chunks: [{ id: "1", text: "t" }] });
    await p.mail.send({ to: "a@b.example", subject: "s", text: "t" });
    await p.dns.resolveTxt("example.com");
    await p.turnstile.verify("tok", "198.51.100.7");
    await p.access.verify(assertion);
    p.stats.write({ name: "n", blobs: ["b"], doubles: [1], index: "i" });
    await p.cache.put("https://x/y", { status: 200, headers: { etag: "e" }, body: new Uint8Array([1]) });
    await p.cache.get("https://x/y"); await p.cache.purge("https://x/y");
    const ticket = await p.uploads.create({ key: "u", max_bytes: 10, content_type: "application/zstd" });
    ports.uploads.receive("u", new Uint8Array([1])); await p.uploads.stat(ticket.key); await p.uploads.read("u");
    await p.audit.append({ type: "t" }); await p.audit.head();
    await p.transparency.anchor({ seq: 0, hash: "h" });
    await p.d1.query("select 1 from t", [1]); await p.d1.batch([{ sql: "update t set a = ?", params: [1] }]);
    const r2 = p.r2["PACKS_PUBLIC"]!;
    await r2.put("k", new Uint8Array([1]), { content_type: "x" }); await r2.get("k"); await r2.head("k"); await r2.list("k"); await r2.delete("k");
    const kv = p.kv["SESSIONS_KV"]!;
    await kv.put("k", "v", { ttl_seconds: 5 }); await kv.get("k"); await kv.list("k"); await kv.delete("k");
    await p.queues["NOTIFY_QUEUE"]!.send({ a: 1 }); await p.queues["NOTIFY_QUEUE"]!.sendBatch([{ a: 1 }]);
    const wf = await p.workflows["VALIDATE_PACK"]!.create({ id: "i", params: { a: 1 } });
    await p.workflows["VALIDATE_PACK"]!.status(wf.id);
    await p.rateLimits["RATE_LIMIT"]!.limit({ key: "k" });
    await p.durableObjects.call("Quota", "n", "peek", [{ kind: "reviews", principal: "p", day: "2026-10-22" }]);
    await recorder.finish(finishInput({ pathParams: { scope: "acme" }, query: {} }));
    expect(recorder.unclassifiedPaths()).toEqual([]);
  });
});
