import { describe, expect, it } from "vitest";
import { createFakePorts, TURNSTILE_PASS_TOKEN } from "../fakes";
import type { GitHub } from "./ports";

describe("GitHub is read-only by type", () => {
  it("has no method that is not a get or a search", () => {
    type Writes = Exclude<keyof GitHub, `get${string}` | `search${string}`>;
    const none: [Writes] extends [never] ? true : false = true;
    expect(none).toBe(true);
  });
});

describe("fakes", () => {
  it("rejects a forged, altered, wrong-audience or expired OIDC token", async () => {
    const p = createFakePorts();
    const token = p.oidc.mint({ aud: "packserver" });
    await expect(p.oidc.verify(token, { audience: "packserver" })).resolves.toMatchObject({ repository: "acme/pack" });
    await expect(p.oidc.verify(`${token}x`, { audience: "packserver" })).rejects.toMatchObject({ code: "bad_signature" });
    await expect(p.oidc.verify(token, { audience: "other" })).rejects.toMatchObject({ code: "bad_audience" });
    p.clock.advance("6m");
    await expect(p.oidc.verify(token, { audience: "packserver" })).rejects.toMatchObject({ code: "expired" });
  });

  it("refuses a minted token whose issuer is not GitHub's", async () => {
    const p = createFakePorts();
    const token = p.oidc.mint({ aud: "a", iss: "https://evil.example" });
    await expect(p.oidc.verify(token, { audience: "a" })).rejects.toMatchObject({ code: "bad_issuer" });
  });

  it("rejects a forged Access assertion", async () => {
    const p = createFakePorts();
    const good = await p.access.assert({ email: "a@b.example", sub: "s" });
    await expect(p.access.verify(good)).resolves.toEqual({ email: "a@b.example", sub: "s" });
    await expect(p.access.verify(good.replace("a@b.example", "x@b.example"))).rejects.toMatchObject({ code: "bad_assertion" });
    await expect(p.access.verify("garbage")).rejects.toMatchObject({ code: "bad_assertion" });
  });

  it("detects an edited, removed or reordered audit entry", async () => {
    const p = createFakePorts();
    for (let i = 0; i < 3; i++) await p.audit.append({ i });
    expect(await p.audit.verify()).toBe(true);
    (p.audit.entries[1]!.event as { i: number }).i = 9;
    expect(await p.audit.verify()).toBe(false);
    const q = createFakePorts();
    for (let i = 0; i < 3; i++) await q.audit.append({ i });
    q.audit.entries.splice(1, 1);
    expect(await q.audit.verify()).toBe(false);
  });

  it("answers Turnstile, vectors and unscripted D1 honestly", async () => {
    const p = createFakePorts();
    expect((await p.turnstile.verify(TURNSTILE_PASS_TOKEN)).success).toBe(true);
    expect((await p.turnstile.verify("nope")).success).toBe(false);
    const [a, b] = await p.embedder.embed(["alpha", "beta"]);
    await p.vectors.upsert([{ id: "a", vector: a! }, { id: "b", vector: b! }]);
    expect((await p.vectors.query(a!, { topK: 1 }))[0]?.id).toBe("a");
    await expect(p.d1.query("select 1")).rejects.toMatchObject({ code: "unscripted" });
  });

  it("repeats ids and floats for the same seed and expires KV by the fake clock", async () => {
    expect(createFakePorts({ seed: 7 }).rng.uuid()).toBe(createFakePorts({ seed: 7 }).rng.uuid());
    const p = createFakePorts();
    await p.kv.put("k", "v", { ttl_seconds: 10 });
    expect(await p.kv.get("k")).toBe("v");
    p.clock.advance("11s");
    expect(await p.kv.get("k")).toBeNull();
  });
});
