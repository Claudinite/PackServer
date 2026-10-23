import { describe, expect, it } from "vitest";
import { KeysDocument, PrivateEntry, RootIndex, ScopeIndex, VersionsDocument } from "@packserver/schema";
import {
  applyRevocations,
  buildKeysDocument,
  buildPrivateEntry,
  buildRoot,
  buildScopeIndex,
  buildVersionsDocument,
  checkScopeAgainstRoot,
  createSigner,
  noblePure,
  promoteStandby,
  signDocument,
  signKeysDocument,
  signPrivateEntry,
  signRoot,
  signScopeIndex,
  signVersionsDocument,
  STALE_GRACE_MS,
  verifySigned,
  type RegistryKey,
  type Verified,
} from "../index";
import { DAY, NOW, keySet, nextStandby, plusDays, privateVersion, seedB, signerA, signerB, version } from "./fixtures";

const pack = { name: "@acme/gcp", versions: [version("1.0.0"), version("1.1.0")] };

async function signedScope(serial = 3, now = NOW) {
  return signScopeIndex(buildScopeIndex({ scope: "acme", serial, now, packs: [pack] }), await signerA());
}

type Json = ReturnType<typeof JSON.parse>;

// A stand-in for what verifySigned returns; production code only gets this brand from verification.
const verifiedKeysDoc = (keys: RegistryKey[]) => ({ keys }) as unknown as Verified<KeysDocument>;

describe("every signed document carries kid, generated_at, expires = +7d and a serial (IT-DELIV-003)", () => {
  it("root, scope index, versions.json, private entry and keys.json verify under the registry key", async () => {
    const keys = await keySet();
    const signer = await signerA();
    const scope = await signedScope();
    const root = await signRoot(buildRoot({ serial: 5, now: NOW, scopes: [{ scope: "acme", sha256: scope.sha256, serial: 3 }] }), signer);
    const versions = await signVersionsDocument(buildVersionsDocument({ serial: 2, now: NOW, pack }), signer);
    const entry = await signPrivateEntry(buildPrivateEntry({ serial: 1, now: NOW, pack: "@acme/secret", versions: [privateVersion("1.0.0", "opq_1")] }), signer);
    const keyDoc = await signKeysDocument(buildKeysDocument({ serial: 1, now: NOW, keys }), signer);

    for (const [schema, published] of [
      [RootIndex, root],
      [ScopeIndex, scope],
      [VersionsDocument, versions],
      [PrivateEntry, entry],
      [KeysDocument, keyDoc],
    ] as const) {
      const result = await verifySigned(schema, JSON.parse(new TextDecoder().decode(published.bytes)), { keys, now: NOW });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(published.doc.kid).toBe("2026-10");
      expect(Date.parse(published.doc.expires) - Date.parse(published.doc.generated_at)).toBe(7 * 24 * 3600 * 1000);
    }
  });

  it("the scope index is served at its content hash and the alias is the same bytes", async () => {
    const scope = await signedScope();
    expect(scope.objectKey).toBe(`index/v1/acme/${scope.sha256}.json`);
    expect(scope.aliasKey).toBe("index/v1/acme.json");
    expect(scope.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signing is deterministic: the same inputs give byte-identical documents", async () => {
    const a = await signedScope();
    const b = await signedScope();
    expect(a.bytes).toEqual(b.bytes);
    expect(a.sha256).toBe(b.sha256);
  });

  it("a signature made on the noble backend verifies on WebCrypto and the reverse", async () => {
    const keys = await keySet();
    const viaNoble = await createSigner({ kid: "2026-10", seed: new Uint8Array(32).fill(7), ed25519: noblePure });
    const doc = await signScopeIndex(buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [pack] }), viaNoble);
    expect((await verifySigned(ScopeIndex, JSON.parse(new TextDecoder().decode(doc.bytes)), { keys, now: NOW })).ok).toBe(true);
    expect((await verifySigned(ScopeIndex, JSON.parse(new TextDecoder().decode(doc.bytes)), { keys, now: NOW, ed25519: noblePure })).ok).toBe(true);
  });
});

describe("tamper negatives", () => {
  const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Json;

  it("refuses a scope index with any signed field changed", async () => {
    const keys = await keySet();
    const good = parse((await signedScope()).bytes);
    const tampers: Array<(d: Json) => void> = [
      (d) => (d.packs[0].versions[0].sha256 = "f".repeat(64)),
      (d) => (d.packs[0].versions[0].status = "yanked"),
      (d) => (d.packs[0].versions[0].verified = false),
      (d) => (d.packs[0].latest_eligible = "1.0.0"),
      (d) => (d.serial = 99),
      (d) => (d.scope = "evil"),
      (d) => d.packs.pop(),
    ];
    for (const tamper of tampers) {
      const bad = structuredClone(good);
      tamper(bad);
      const result = await verifySigned(ScopeIndex, bad, { keys, now: NOW });
      expect(result.ok).toBe(false);
    }
  });

  it("returns malformed, never throws, on served input carrying a lone surrogate", async () => {
    const keys = await keySet();
    const good = parse((await signedScope()).bytes);
    const stripped = structuredClone(good);
    stripped.packs[0].versions[0].smuggled = "\ud800";
    expect(await verifySigned(ScopeIndex, stripped, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
    const inReason = structuredClone(good);
    inReason.packs[0].versions[0].status = "yanked";
    inReason.packs[0].versions[0].reason = "bad \udc00 reason";
    expect(await verifySigned(ScopeIndex, inReason, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
    const inKey = structuredClone(good);
    inKey.packs[0].versions[0]["\ud800"] = 1;
    expect(await verifySigned(ScopeIndex, inKey, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
  });

  it("refuses a flipped signature bit, a swapped kid, a missing signature and an unknown extra top-level field", async () => {
    const keys = await keySet();
    const good = parse((await signedScope()).bytes);
    const flipped = { ...good, signature: (good.signature[0] === "A" ? "B" : "A") + good.signature.slice(1) };
    expect(await verifySigned(ScopeIndex, flipped, { keys, now: NOW })).toMatchObject({ ok: false, code: "signature" });
    expect(await verifySigned(ScopeIndex, { ...good, kid: "2027-04" }, { keys, now: NOW })).toMatchObject({ ok: false, code: "signature" });
    const unsigned = { ...good };
    delete unsigned.signature;
    expect(await verifySigned(ScopeIndex, unsigned, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifySigned(ScopeIndex, { ...good, extra: 1 }, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
  });

  it("refuses a document signed by a key the set does not know", async () => {
    const keys = await keySet();
    const stranger = await createSigner({ kid: "evil", seed: new Uint8Array(32).fill(1) });
    const doc = await signScopeIndex(buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [pack] }), stranger);
    expect(await verifySigned(ScopeIndex, parse(doc.bytes), { keys, now: NOW })).toMatchObject({ ok: false, code: "unknown-kid" });
  });

  it("refuses a known kid whose signature was made with another private key", async () => {
    const keys = await keySet();
    const impostor = await createSigner({ kid: "2026-10", seed: new Uint8Array(32).fill(1) });
    const doc = await signScopeIndex(buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [pack] }), impostor);
    expect(await verifySigned(ScopeIndex, parse(doc.bytes), { keys, now: NOW })).toMatchObject({ ok: false, code: "signature" });
  });

  it("refuses malleated signature encodings", async () => {
    const keys = await keySet();
    const good = parse((await signedScope()).bytes);
    expect(await verifySigned(ScopeIndex, { ...good, signature: good.signature + "=" }, { keys, now: NOW })).toMatchObject({ ok: false });
    expect(await verifySigned(ScopeIndex, { ...good, signature: "" }, { keys, now: NOW })).toMatchObject({ ok: false });
  });

  it("refuses an expiry that is not generated_at + 7 days even if validly signed", async () => {
    const keys = await keySet();
    const signer = await signerA();
    const unsigned = { ...buildRoot({ serial: 1, now: NOW, scopes: [] }), expires: plusDays(30).toISOString() };
    const doc = await signDocument(unsigned, signer);
    expect(await verifySigned(RootIndex, doc, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("expiry and rollback (REQ-CN-002 library half)", () => {
  it("refuses an expired document as index.stale, and accepts it one millisecond before expiry", async () => {
    const keys = await keySet();
    const doc = (await signedScope()).doc;
    const expires = Date.parse(doc.expires);
    expect(await verifySigned(ScopeIndex, doc, { keys, now: new Date(expires - 1) })).toMatchObject({ ok: true });
    expect(await verifySigned(ScopeIndex, doc, { keys, now: new Date(expires) })).toMatchObject({ ok: false, code: "index.stale" });
    expect(await verifySigned(ScopeIndex, doc, { keys, now: plusDays(30) })).toMatchObject({ ok: false, code: "index.stale" });
  });

  it("in report mode returns a stale document flagged, still requiring a valid signature, and marks it unknown-status after the 7-day grace", async () => {
    const keys = await keySet();
    const doc = (await signedScope()).doc;
    const expires = Date.parse(doc.expires);
    const fresh = await verifySigned(ScopeIndex, doc, { keys, now: NOW, staleness: "report" });
    expect(fresh).toMatchObject({ ok: true, freshness: "fresh" });
    const stale = await verifySigned(ScopeIndex, doc, { keys, now: new Date(expires + 3 * DAY), staleness: "report" });
    expect(stale).toMatchObject({ ok: true, freshness: "stale" });
    const grace = await verifySigned(ScopeIndex, doc, { keys, now: new Date(expires + STALE_GRACE_MS), staleness: "report" });
    expect(grace).toMatchObject({ ok: true, freshness: "stale" });
    const unknown = await verifySigned(ScopeIndex, doc, { keys, now: new Date(expires + STALE_GRACE_MS + 1), staleness: "report" });
    expect(unknown).toMatchObject({ ok: true, freshness: "status-unknown" });
    const forged = { ...doc, serial: 77 };
    expect(await verifySigned(ScopeIndex, forged, { keys, now: new Date(expires + DAY), staleness: "report" })).toMatchObject({ ok: false, code: "signature" });
    expect(await verifySigned(ScopeIndex, doc, { keys, now: new Date(expires + DAY), staleness: "report", lastSerial: 9 })).toMatchObject({ ok: false, code: "index.rollback" });
  });

  it("reports the backend that verified", async () => {
    const keys = await keySet();
    const doc = (await signedScope()).doc;
    expect(await verifySigned(ScopeIndex, doc, { keys, now: NOW })).toMatchObject({ ok: true, backend: "webcrypto" });
    expect(await verifySigned(ScopeIndex, doc, { keys, now: NOW, ed25519: noblePure })).toMatchObject({ ok: true, backend: "noble" });
  });

  it("refuses a lower serial than the last verified as index.rollback, accepts an equal or higher one", async () => {
    const keys = await keySet();
    const doc = (await signedScope(5)).doc;
    expect(await verifySigned(ScopeIndex, doc, { keys, now: NOW, lastSerial: 6 })).toMatchObject({ ok: false, code: "index.rollback" });
    expect(await verifySigned(ScopeIndex, doc, { keys, now: NOW, lastSerial: 5 })).toMatchObject({ ok: true });
    expect(await verifySigned(ScopeIndex, doc, { keys, now: NOW, lastSerial: 4 })).toMatchObject({ ok: true });
  });

  it("a forged serial cannot dodge the rollback check because the signature is judged first", async () => {
    const keys = await keySet();
    const old = structuredClone((await signedScope(2)).doc);
    old.serial = 100;
    expect(await verifySigned(ScopeIndex, old, { keys, now: NOW, lastSerial: 50 })).toMatchObject({ ok: false, code: "signature" });
  });
});

describe("kind confusion (REQ-PRIV-020, ARCH-REV H1)", () => {
  it("a private entry is not accepted as a scope index or root, and the reverse", async () => {
    const keys = await keySet();
    const signer = await signerA();
    const entry = await signPrivateEntry(buildPrivateEntry({ serial: 1, now: NOW, pack: "@acme/secret", versions: [privateVersion("1.0.0", "opq_1")] }), signer);
    const scope = await signedScope();
    expect(await verifySigned(ScopeIndex, entry.doc, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifySigned(RootIndex, entry.doc, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifySigned(PrivateEntry, scope.doc, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifySigned(KeysDocument, scope.doc, { keys, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("scope index follows the root's hash (ARCH-REV H1)", () => {
  it("accepts the object the root names and refuses a swapped one, a wrong serial and an unlisted scope", async () => {
    const signer = await signerA();
    const scope = await signedScope(3);
    const other = await signedScope(4);
    const root = (await signRoot(buildRoot({ serial: 1, now: NOW, scopes: [{ scope: "acme", sha256: scope.sha256, serial: 3 }] }), signer)).doc;
    expect(await checkScopeAgainstRoot(root, "acme", scope.bytes, scope.doc)).toEqual({ ok: true });
    expect(await checkScopeAgainstRoot(root, "acme", other.bytes, other.doc)).toMatchObject({ ok: false });
    expect(await checkScopeAgainstRoot(root, "acme", scope.bytes, { ...scope.doc, serial: 9 })).toMatchObject({ ok: false });
    expect(await checkScopeAgainstRoot(root, "nope", scope.bytes, scope.doc)).toMatchObject({ ok: false });
    const flipped = Uint8Array.from(scope.bytes);
    flipped[5] = (flipped[5] ?? 0) ^ 1;
    expect(await checkScopeAgainstRoot(root, "acme", flipped, scope.doc)).toMatchObject({ ok: false });
  });
});

describe("key set, promotion and keys.json (IT-DELIV-016)", () => {
  it("promotion revokes the old active, activates the standby, seats the next standby", async () => {
    const next = promoteStandby(await keySet(), { now: NOW, nextStandby: await nextStandby() });
    expect(next.map((k) => [k.kid, k.status])).toEqual([
      ["2026-10", "revoked"],
      ["2027-04", "active"],
      ["2027-10", "standby"],
    ]);
    expect(next[0]?.revoked_at).toBe(NOW.toISOString());
  });

  it("refuses to promote without a standby, or a key set with two actives or a repeated kid", async () => {
    const keys = await keySet();
    expect(() => promoteStandby([keys[0]!], { now: NOW, nextStandby: { kid: "x", public_key: keys[0]!.public_key } })).toThrow();
    expect(() => buildKeysDocument({ serial: 1, now: NOW, keys: [keys[0]!, { ...keys[1]!, status: "active" }] })).toThrow();
    expect(() => buildKeysDocument({ serial: 1, now: NOW, keys: [keys[0]!, { ...keys[1]!, kid: "2026-10" }] })).toThrow();
    expect(() => buildKeysDocument({ serial: 1, now: NOW, keys: [{ ...keys[0]!, public_key: "AAAA" }] })).toThrow();
  });

  it("after promotion everything verifies under the new kid and the retired kid's signatures are refused even though they verify", async () => {
    const before = await keySet();
    const oldSigner = await signerA();
    const oldScope = await signScopeIndex(buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [pack] }), oldSigner);
    expect((await verifySigned(ScopeIndex, oldScope.doc, { keys: before, now: NOW })).ok).toBe(true);

    const promotedAt = new Date(NOW.getTime() + 30 * 60 * 1000);
    const after = promoteStandby(before, { now: promotedAt, nextStandby: await nextStandby() });
    const newSigner = await signerB();
    const keysDoc = await signKeysDocument(buildKeysDocument({ serial: 2, now: promotedAt, keys: after }), newSigner);
    expect(keysDoc.doc.kid).toBe("2027-04");
    expect(keysDoc.doc.keys.find((k) => k.kid === "2026-10")).toMatchObject({ status: "revoked", revoked_at: promotedAt.toISOString() });

    // cn holds the embedded set (old active, standby) and reads the keys document signed by the standby.
    const verifiedKeys = await verifySigned(KeysDocument, keysDoc.doc, { keys: before, now: promotedAt });
    expect(verifiedKeys.ok).toBe(true);
    if (!verifiedKeys.ok) throw new Error("keys document must verify");
    const trusted = applyRevocations(before, verifiedKeys.doc);
    expect(trusted.find((k) => k.kid === "2026-10")?.status).toBe("revoked");

    expect(await verifySigned(ScopeIndex, oldScope.doc, { keys: trusted, now: promotedAt })).toMatchObject({ ok: false, code: "revoked-kid" });
    const resigned = await signScopeIndex(buildScopeIndex({ scope: "acme", serial: 2, now: promotedAt, packs: [pack] }), newSigner);
    expect((await verifySigned(ScopeIndex, resigned.doc, { keys: trusted, now: promotedAt })).ok).toBe(true);
  });

  it("a keys document signed by a revoked key is refused", async () => {
    const keys = promoteStandby(await keySet(), { now: NOW, nextStandby: await nextStandby() });
    const doc = await signKeysDocument(buildKeysDocument({ serial: 9, now: NOW, keys }), await signerA());
    expect(await verifySigned(KeysDocument, doc.doc, { keys, now: NOW })).toMatchObject({ ok: false, code: "revoked-kid" });
  });

  it("applyRevocations takes only a verified keys document", async () => {
    const trusted = await keySet();
    const rotated = promoteStandby(trusted, { now: NOW, nextStandby: await nextStandby() });
    const signed = await signKeysDocument(buildKeysDocument({ serial: 2, now: NOW, keys: rotated }), await signerB());
    // @ts-expect-error a parsed but unverified document is not accepted by type
    applyRevocations(trusted, signed.doc);
    const verified = await verifySigned(KeysDocument, signed.doc, { keys: trusted, now: NOW });
    if (!verified.ok) throw new Error("expected a verified keys document");
    expect(applyRevocations(trusted, verified.doc).find((k) => k.kid === "2026-10")?.status).toBe("revoked");
  });

  it("applyRevocations never adds a key and never un-revokes one", async () => {
    const trusted = await keySet();
    const doc = verifiedKeysDoc([{ kid: "rogue", public_key: trusted[0]!.public_key, status: "active" }, { ...trusted[0]!, status: "active" }]);
    expect(applyRevocations(trusted, doc).map((k) => k.kid)).toEqual(["2026-10", "2027-04"]);
    const revoked: RegistryKey[] = [{ ...trusted[0]!, status: "revoked", revoked_at: NOW.toISOString() }];
    expect(applyRevocations(revoked, doc)[0]?.status).toBe("revoked");
  });

  it("the standby key signs verifiably before it is promoted only so a promotion can be read", async () => {
    const keys = await keySet();
    const doc = await signScopeIndex(buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [pack] }), await signerB());
    expect((await verifySigned(ScopeIndex, doc.doc, { keys, now: NOW })).ok).toBe(true);
    expect(seedB.length).toBe(32);
  });

  it("refuses to sign a document that already names another kid", async () => {
    await expect(signDocument({ ...buildRoot({ serial: 1, now: NOW, scopes: [] }), kid: "other" }, await signerA())).rejects.toThrow();
    await expect(signDocument({ kind: "x", signature: "s" }, await signerA())).rejects.toThrow();
  });
});
