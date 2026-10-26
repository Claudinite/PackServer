import { buildScopeIndex, buildRoot, verifySigned } from "@packserver/core/index";
import { INDEX_HEADERS, KEYS_KEY, ROOT_KEY } from "@packserver/core/validation";
import { KeysDocument, RootIndex, ScopeIndex } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { signAndWritePrivateEntries, signAndWriteRootDocument, signAndWriteScopeIndex } from "../src/sign/documents";
import { signEntrypoints } from "../src/entrypoints/sign";
import { KID, SEED, seedScope, testRuntime } from "./support";
import { encodePublicKey } from "@packserver/core/index";

const parse = (bytes: Uint8Array | null | undefined) => JSON.parse(new TextDecoder().decode(bytes!)) as unknown;
const keysOf = async () => [{ kid: KID, public_key: await encodePublicKey(SEED), status: "active" as const }];

describe("signing a scope index", () => {
  it("writes the immutable hashed object and the live alias with the same bytes, and the document verifies", async () => {
    const { rt, publicBucket, fakes } = await testRuntime();
    const now = new Date(fakes.clock.now());
    const ack = await signAndWriteScopeIndex(rt, { scope: "acme", unsigned: buildScopeIndex({ scope: "acme", serial: 1, now, packs: [] }) });

    expect(ack).toMatchObject({ serial: 1, kid: KID, key: `index/v1/acme/${ack.sha256}.json` });
    const hashed = publicBucket.objects.get(`index/v1/acme/${ack.sha256}.json`)!;
    const alias = publicBucket.objects.get("index/v1/acme.json")!;
    expect(alias.body).toEqual(hashed.body);
    expect(hashed.cache_control).toBe(INDEX_HEADERS.immutable.cacheControl);
    expect(alias.cache_control).toBe(INDEX_HEADERS.live.cacheControl);
    expect(alias.content_disposition).toMatch(/^attachment;/);
    expect((await verifySigned(ScopeIndex, parse(alias.body), { keys: await keysOf(), now })).ok).toBe(true);
  });

  it("continues from the last serial it signed when the coordinator's count was lost", async () => {
    const { rt, fakes } = await testRuntime();
    const now = new Date(fakes.clock.now());
    const make = (serial: number) => ({ scope: "acme", unsigned: buildScopeIndex({ scope: "acme", serial, now, packs: [] }) });
    expect((await signAndWriteScopeIndex(rt, make(5))).serial).toBe(5);
    expect((await signAndWriteScopeIndex(rt, make(1))).serial).toBe(6);
    expect((await signAndWriteScopeIndex(rt, make(9))).serial).toBe(9);
  });

  it("refuses to sign when the bound key is not the active one", async () => {
    const { rt } = await testRuntime({ seed: new Uint8Array(32).fill(6) });
    const unsigned = buildScopeIndex({ scope: "acme", serial: 1, now: new Date(rt.ports.clock.now()), packs: [] });
    await expect(signAndWriteScopeIndex(rt, { scope: "acme", unsigned })).rejects.toThrow(/keys.unavailable/);
  });

  it("refuses to sign without a key set", async () => {
    const { rt } = await testRuntime({ withKeys: false });
    const unsigned = buildScopeIndex({ scope: "acme", serial: 1, now: new Date(rt.ports.clock.now()), packs: [] });
    await expect(signAndWriteScopeIndex(rt, { scope: "acme", unsigned })).rejects.toThrow(/registry_keys/);
  });

  it("leaves an object it wrote earlier alone: the same document signed twice is one object", async () => {
    const { rt, publicBucket, fakes } = await testRuntime();
    const unsigned = buildScopeIndex({ scope: "acme", serial: 1, now: new Date(fakes.clock.now()), packs: [] });
    const first = await signAndWriteScopeIndex(rt, { scope: "acme", unsigned });
    const second = await signAndWriteScopeIndex(rt, { scope: "acme", unsigned: { ...unsigned, serial: first.serial } });
    expect(second.serial).toBeGreaterThan(first.serial);
    expect([...publicBucket.objects.keys()].filter((k) => k.startsWith("index/v1/acme/"))).toHaveLength(2);
  });
});

describe("signing the root", () => {
  it("writes keys.json beside the root, each signed by the active key", async () => {
    const { rt, publicBucket, fakes } = await testRuntime();
    const now = new Date(fakes.clock.now());
    const ack = await signAndWriteRootDocument(rt, { unsigned: buildRoot({ serial: 1, now, scopes: [{ scope: "acme", sha256: "b".repeat(64), serial: 3 }] }) });
    expect(ack).toMatchObject({ serial: 1, key: ROOT_KEY, kid: KID });
    expect((await verifySigned(RootIndex, parse(publicBucket.objects.get(ROOT_KEY)?.body), { keys: await keysOf(), now })).ok).toBe(true);
    const keys = parse(publicBucket.objects.get(KEYS_KEY)?.body) as { keys: Array<{ kid: string }> };
    expect((await verifySigned(KeysDocument, keys, { keys: await keysOf(), now })).ok).toBe(true);
    expect(keys.keys.map((k) => k.kid)).toEqual([KID]);
  });
});

describe("signing private entries", () => {
  const entry = (pack: string, serial: number, now: Date) => ({ kind: "private" as const, pack, serial, generated_at: now.toISOString(), expires: new Date(now.getTime() + 7 * 86_400_000).toISOString(), versions: [] });

  it("writes each entry at its pack's private key and never into the public bucket", async () => {
    const { rt, db, publicBucket, privateBucket, fakes } = await testRuntime();
    seedScope(db, { visibility: "private" });
    const now = new Date(fakes.clock.now());
    const acks = await signAndWritePrivateEntries(rt, { scope: "acme", entries: [entry("@acme/gcp", 1, now)] });
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ pack: "@acme/gcp", key: "private-index/p-acme-gcp.json" });
    expect(privateBucket.objects.get("private-index/p-acme-gcp.json")?.cache_control).toBe("private, no-store");
    expect(publicBucket.objects.size).toBe(0);
  });

  it("refuses a pack that is public or not in the registry", async () => {
    const { rt, db, fakes } = await testRuntime();
    seedScope(db, { visibility: "public" });
    const now = new Date(fakes.clock.now());
    await expect(signAndWritePrivateEntries(rt, { scope: "acme", entries: [entry("@acme/gcp", 1, now)] })).rejects.toThrow(/sign.not_private/);
    await expect(signAndWritePrivateEntries(rt, { scope: "acme", entries: [entry("@acme/none", 1, now)] })).rejects.toThrow(/sign.unknown_pack/);
  });
});

describe("the entrypoints", () => {
  it("parse the request again: a document for another scope is refused", async () => {
    const { rt, fakes } = await testRuntime();
    const unsigned = buildScopeIndex({ scope: "acme", serial: 1, now: new Date(fakes.clock.now()), packs: [] });
    const sign = signEntrypoints(rt);
    await expect(sign.signScopeIndex({ scope: "other", unsigned })).rejects.toThrow();
    await expect(sign.signScopeIndex({ scope: "acme" })).rejects.toThrow();
    expect(await sign.signScopeIndex({ scope: "acme", unsigned })).toMatchObject({ serial: 1 });
  });
});
