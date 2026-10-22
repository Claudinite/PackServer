import type { GitHubRepo } from "./ports";
import { VOLATILE_PLACEHOLDERS } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { createFakePorts, FakeClock } from "../fakes";
import { BASE_RULES, assertNoCatchAllGrant, redact } from "./classification";
import { canonicalIp, deriveDayKey, ipHash } from "./hash";
import { BINDING_SPECS, DO_CLASSES, PORT_SPECS, instrumentAll, treeRules, type ClassTree } from "./instrument";
import { Normalizer, responseHeaders, stripLocationQuery } from "./normalize";
import { createRecorder, type FinishInput } from "./recorder";

const context = { request_id: "r", side: "live", worker: "w", version_id: "v", release_id: "r" };
const keys = { redaction: "rk", principal: "pk" };
const fin = (extra: Partial<FinishInput["response"]> = {}): FinishInput => ({
  request: { method: "GET", route: "/x", headers: {}, principal: null },
  response: { status: 200, headers: {}, ms: 1, error: null, ...extra },
  outcome: "ok",
});
const wet = (clock = new FakeClock()) => createRecorder({ mode: "wet", context, clock, keys });

describe("default deny holds for fields no rule names", () => {
  it("keeps an unexpected OIDC claim out of the record and reports it", async () => {
    const ports = createFakePorts();
    const token = ports.oidc.mint({ aud: "a", actor: "octocat-person", actor_email: "p@x.example" } as never);
    const rec = wet(ports.clock);
    await instrumentAll(ports, rec).oidc.verify(token, { audience: "a" });
    const e = (await rec.finish(fin()))!;
    expect(JSON.stringify(e)).not.toMatch(/octocat-person|p@x\.example/);
    expect(rec.unclassifiedPaths()).toEqual(expect.arrayContaining(["inv.token_actions_githubusercontent_com.verify.result.actor"]));
  });

  it("keeps a nested owner object of a GitHub repo out of the record", async () => {
    const ports = createFakePorts();
    ports.github.repos.set("a/b", { slug: "a/b", id: 1, default_branch: "main", private: false, archived: false, owner: { login: "someone" } } as never);
    const rec = wet(ports.clock);
    await instrumentAll(ports, rec).github.getRepo("a/b");
    expect(JSON.stringify(await rec.finish(fin()))).not.toContain("someone");
    expect(rec.unclassifiedPaths().some((p) => p.endsWith("result.owner.login"))).toBe(true);
  });

  it("refuses any rule that grants public or operational with a trailing **", () => {
    expect(() => assertNoCatchAllGrant({ "a.**": "operational" })).toThrow("unnamed fields");
    expect(() => assertNoCatchAllGrant({ "**.email": "personal" })).not.toThrow();
    expect(() => assertNoCatchAllGrant(BASE_RULES)).not.toThrow();
    expect(() => createRecorder({ mode: "wet", context, clock: new FakeClock(), keys, rules: { "r.**": "public" } })).toThrow();
  });

  it("generates no catch-all grant from any port spec", () => {
    const all = [...Object.values(PORT_SPECS), ...Object.values(BINDING_SPECS)];
    for (const spec of all) {
      for (const m of Object.values(spec.methods) as Array<{ args?: unknown; result?: unknown }>) {
        expect(() => assertNoCatchAllGrant(treeRules(m.args, "request.args"))).not.toThrow();
        expect(() => assertNoCatchAllGrant(treeRules(m.result, "result"))).not.toThrow();
      }
    }
    for (const methods of Object.values(DO_CLASSES)) {
      for (const m of Object.values(methods) as Array<{ args: unknown; result: unknown }>) {
        expect(() => assertNoCatchAllGrant({ ...treeRules(m.args, "a"), ...treeRules(m.result, "r") })).not.toThrow();
      }
    }
  });

  it("makes the type require every field of a port type to be classified", () => {
    const complete: ClassTree<GitHubRepo> = { slug: "operational", id: "operational", default_branch: "operational", private: "operational", archived: "operational" };
    // @ts-expect-error `archived` is not classified: a field added to a port type must fail the build until it is
    const missing: ClassTree<GitHubRepo> = { slug: "operational", id: "operational", default_branch: "operational", private: "operational" };
    expect([complete, missing]).toHaveLength(2);
  });
});

describe("class inheritance", () => {
  it("keeps the stricter of a container's class and a child's own rule", async () => {
    const r = await redact({ email: { address: "leak@x.example" } }, "result", { ...BASE_RULES, "result.**": "operational" }, "k");
    expect(JSON.stringify(r.value)).not.toContain("leak@x.example");
    expect((r.value as { email: { address: string } }).email.address).toMatch(/^<personal:/);
  });

  it("does not let a leaf rule loosen a customer-content container", async () => {
    const r = await redact({ rows: [{ id: "row-1" }] }, "r", { "r.rows": "customer-content", "r.rows.*.id": "operational" }, "k");
    expect(JSON.stringify(r.value)).not.toContain("row-1");
  });

  it("lets a secret descendant win over an operational container", async () => {
    const r = await redact({ n: 1, password: "p" }, "r", { r: "operational", ...BASE_RULES }, "k");
    expect(r.value).toEqual({ n: 1 });
  });
});

describe("byte bodies and the invocation cap", () => {
  const put = async (body: Uint8Array) => {
    const ports = createFakePorts();
    const rec = wet(ports.clock);
    await instrumentAll(ports, rec).r2["public"]!.put("k", body);
    return { e: (await rec.finish(fin()))!, rec };
  };

  it("records a byte body as one keyed placeholder, not one per byte", async () => {
    const { e } = await put(new TextEncoder().encode("SECRETPACKTEXT"));
    const args = (e.invocations[0]!.request as { args: unknown[] }).args;
    expect(args[1]).toMatch(/^<customer-content:[0-9a-f]{16}>$/);
    expect(JSON.stringify(e.invocations[0])).not.toMatch(/\{"0":|\[\d+,\d+/);
  });

  it("gives equal bytes one placeholder and different bytes another, under the key", async () => {
    const a = (await put(new Uint8Array([1, 2, 3]))).e.invocations[0]!.request as { args: unknown[] };
    const b = (await put(new Uint8Array([1, 2, 3]))).e.invocations[0]!.request as { args: unknown[] };
    const c = (await put(new Uint8Array([1, 2, 4]))).e.invocations[0]!.request as { args: unknown[] };
    expect(a.args[1]).toBe(b.args[1]);
    expect(a.args[1]).not.toBe(c.args[1]);
  });

  it("keeps a 20 KB body to a hash-sized record", async () => {
    const { e } = await put(new Uint8Array(20_000).fill(7));
    expect(JSON.stringify(e.invocations[0]).length).toBeLessThan(1000);
  });

  it("hashes an invocation request over 4 KB and marks the record truncated", async () => {
    const ports = createFakePorts();
    const rec = wet(ports.clock);
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field${i}`, "v"]));
    await instrumentAll(ports, rec).queues["notify"]!.send(wide);
    const e = (await rec.finish(fin()))!;
    const inv = e.invocations[0]!;
    expect(inv.request).toBeNull();
    expect(inv.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.truncated).toBe(true);
  });
});

describe("stack_hash", () => {
  const withStack = (message: string) => {
    const err = new Error(message);
    err.stack = `Error: ${message}\n    at handler (/app/src/index.ts:10:5)\n    at run (/app/src/run.ts:2:1)`;
    return err;
  };

  it("is keyed and covers the frames only, so a message cannot be confirmed offline", async () => {
    const { sha256Hex } = await import("./hash");
    const a = (await wet().finish(fin({ error: withStack("no account for leak@x.example") })))!;
    const b = (await wet().finish(fin({ error: withStack("another message") })))!;
    expect(a.response.error!.stack_hash).toBe(b.response.error!.stack_hash);
    expect(a.response.error!.stack_hash).not.toBe(await sha256Hex(withStack("no account for leak@x.example").stack!));
    expect(a.response.error!.stack_hash).not.toBe(await sha256Hex("Error: no account for leak@x.example"));
    const other = await createRecorder({ mode: "wet", context, clock: new FakeClock(), keys: { ...keys, redaction: "other" } }).finish(fin({ error: withStack("x") }));
    expect(other!.response.error!.stack_hash).not.toBe(a.response.error!.stack_hash);
  });

  it("falls back to the error name when there are no frames", async () => {
    const err = new TypeError("secret@x.example");
    err.stack = "TypeError: secret@x.example";
    const a = (await wet().finish(fin({ error: err })))!;
    const err2 = new TypeError("different");
    err2.stack = "TypeError: different";
    expect((await wet().finish(fin({ error: err2 })))!.response.error!.stack_hash).toBe(a.response.error!.stack_hash);
  });
});

describe("one port per binding", () => {
  it("names the binding as the target", async () => {
    const ports = createFakePorts({ r2: ["public", "staging"], kv: ["sessions", "cache"] });
    const rec = wet(ports.clock);
    const p = instrumentAll(ports, rec);
    await p.r2["public"]!.put("a", new Uint8Array([1]));
    await p.r2["staging"]!.get("a");
    await p.kv["cache"]!.get("k");
    const e = (await rec.finish(fin()))!;
    expect(e.invocations.map((i) => [i.kind, i.target, i.op])).toEqual([
      ["r2", "public", "put"],
      ["r2", "staging", "get"],
      ["kv", "cache", "get"],
    ]);
    expect(ports.r2["public"]!.objects.has("a")).toBe(true);
    expect(ports.r2["staging"]!.objects.has("a")).toBe(false);
  });
});

describe("workflows, rate limits and Durable Objects", () => {
  it("records a workflow start and a rate-limit check with the key as a personal value", async () => {
    const ports = createFakePorts({ rateLimits: { api: { limit: 1, periodMs: 1000 } } });
    const rec = wet(ports.clock);
    const p = instrumentAll(ports, rec);
    await p.workflows["validate-pack"]!.create({ id: "run-1", params: { text: "MARKER" } });
    expect((await p.rateLimits["api"]!.limit({ key: "198.51.100.7" })).success).toBe(true);
    expect((await p.rateLimits["api"]!.limit({ key: "198.51.100.7" })).success).toBe(false);
    ports.clock.advance("2s");
    expect((await p.rateLimits["api"]!.limit({ key: "198.51.100.7" })).success).toBe(true);
    const e = (await rec.finish(fin()))!;
    expect(e.invocations.map((i) => [i.kind, i.target])).toEqual([["workflow", "validate-pack"], ["ratelimit", "api"], ["ratelimit", "api"], ["ratelimit", "api"]]);
    expect(JSON.stringify(e)).not.toMatch(/MARKER|198\.51\.100\.7/);
  });

  it("types the Durable Object call by the schema's RPC and classifies by method", async () => {
    const ports = createFakePorts();
    ports.durableObjects.register("Quota", "q", { consume: () => ({ schema_version: 1, allowed: true, count: 1, cap: 5 }) });
    const rec = wet(ports.clock);
    const out = await instrumentAll(ports, rec).durableObjects.call("Quota", "q", "consume", [
      { kind: "reviews", principal: "user-42", day: "2026-10-22", cap: 5 },
    ]);
    expect(out.allowed).toBe(true);
    // @ts-expect-error `bogus` is not a Quota method in the schema's contract
    await expect(ports.durableObjects.call("Quota", "q", "bogus", [])).rejects.toThrow("no Durable Object method");
    const e = (await rec.finish(fin()))!;
    const inv = e.invocations[0]!;
    expect(inv).toMatchObject({ kind: "do", target: "do", op: "Quota.consume", effect: "write" });
    expect(JSON.stringify(inv)).not.toContain("user-42");
    expect(rec.unclassifiedPaths()).toEqual([]);
  });

  it("fails closed on a Durable Object method with no classification", () => {
    const ports = createFakePorts();
    const p = instrumentAll(ports, wet(ports.clock));
    expect(() => (p.durableObjects.call as (...a: unknown[]) => unknown)("Quota", "q", "unknown", [])).toThrow("no recorder classification");
  });
});

describe("volatile placeholders", () => {
  it("only emits placeholders the schema lists, and emits all of them", () => {
    const n = new Normalizer(Date.parse("2026-10-22T12:00:00Z"));
    const out = n.value({
      ts: "2026-10-22T12:00:01Z",
      id: "11111111-1111-4111-8111-111111111111",
      sig: "x",
      session: "x",
      cursor: "x",
      rowid: 1,
    }) as Record<string, string>;
    const shapes = Object.values(out).map((v) => v.replace(/<uuid:\d+>/, "<uuid:n>"));
    expect([...shapes].sort()).toEqual([...VOLATILE_PLACEHOLDERS].sort());
  });
});

describe("ip_hash canonical form", () => {
  it("hashes every spelling of one address alike", async () => {
    const k = await deriveDayKey("master", "2026-10-22");
    expect(await ipHash(k, "::1")).toBe(await ipHash(k, "0:0:0:0:0:0:0:1"));
    expect(await ipHash(k, "2001:DB8::8a2e:370:7334")).toBe(await ipHash(k, "2001:0db8:0000:0000:0000:8a2e:0370:7334"));
    expect(await ipHash(k, "::ffff:198.51.100.7")).toBe(await ipHash(k, "198.51.100.7"));
    expect(await ipHash(k, "::ffff:c633:6407")).toBe(await ipHash(k, "198.51.100.7"));
    expect(await ipHash(k, "fe80::1%eth0")).toBe(await ipHash(k, "fe80::1"));
  });

  it("keeps different addresses apart and leaves junk as typed", async () => {
    const k = await deriveDayKey("master", "2026-10-22");
    expect(await ipHash(k, "2001:db8::1")).not.toBe(await ipHash(k, "2001:db8::2"));
    expect(canonicalIp("not an ip:")).toBe("not an ip:");
    expect(canonicalIp("1:2:3")).toBe("1:2:3");
  });
});

describe("location header", () => {
  it("drops query values and the fragment but keeps the path and the keys", () => {
    expect(stripLocationQuery("https://app.example/cb?code=abc&state=xyz#frag")).toBe("https://app.example/cb?code=&state=");
    expect(stripLocationQuery("/packs/@a/b")).toBe("/packs/@a/b");
    expect(responseHeaders({ Location: "/cb?code=SECRET" }).location).toBe("/cb?code=");
  });

  it("never reaches the envelope with a code in it", async () => {
    const e = (await wet().finish(fin({ headers: { Location: "https://x.example/cb?code=SECRETCODE&state=S" } })))!;
    expect(JSON.stringify(e)).not.toMatch(/SECRETCODE|state=S"/);
  });
});

describe("deny classes beat grants", () => {
  it("keeps set-cookie, authorization and email out of a map granted operational", async () => {
    const value = { headers: { "set-cookie": "s=SECRETCOOKIE", authorization: "Bearer SECRETTOKEN", email: "a@b.example", etag: "e1" } };
    const r = await redact(value, "r", { ...BASE_RULES, "r.headers.*": "operational" }, "k");
    const text = JSON.stringify(r.value);
    expect(text).not.toMatch(/SECRETCOOKIE|SECRETTOKEN|a@b\.example/);
    expect((r.value as typeof value).headers.etag).toBe("e1");
  });

  it("keeps them out of a cached response recorded through the port", async () => {
    const ports = createFakePorts();
    ports.cache.entries.set("https://x/y", {
      status: 200,
      headers: { etag: "e1", "set-cookie": "s=SECRETCOOKIE", authorization: "Bearer SECRETTOKEN", email: "a@b.example" } as never,
      body: new Uint8Array([1]),
    });
    const rec = wet(ports.clock);
    await instrumentAll(ports, rec).cache.get("https://x/y");
    const text = JSON.stringify(await rec.finish(fin()));
    expect(text).not.toMatch(/SECRETCOOKIE|SECRETTOKEN|a@b\.example/);
    expect(text).toContain("e1");
  });

  it("makes the type refuse a wildcard grant on a string-keyed map", () => {
    const ok: ClassTree<Record<string, string>> = "customer-content";
    // @ts-expect-error a map's keys cannot be named, so only a blanket sensitive class is allowed
    const bad: ClassTree<Record<string, string>> = { "*": "operational" };
    expect([ok, bad]).toHaveLength(2);
  });
});

describe("ordering", () => {
  it("numbers uuids by call order even when calls overlap", async () => {
    const ports = createFakePorts();
    const rec = wet(ports.clock);
    const p = instrumentAll(ports, rec);
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    await Promise.all(ids.map((id) => p.kv["sessions"]!.get(id)));
    const e = (await rec.finish(fin()))!;
    expect(e.invocations.map((i) => (i.request as { args: string[] }).args[0])).toEqual(["<uuid:1>", "<uuid:2>"]);
  });
});
