import { describe, expect, it } from "vitest";
import { signAttestation, verifyAttestation, createSigner } from "../index";
import { keySet, oidcAttestation, signerA, signerB } from "./fixtures";
import { promoteStandby } from "../index";
import { NOW, nextStandby } from "./fixtures";

const expectOidc = { pack: "@acme/gcp", version: "1.61021.1", canonical_sha256: "d".repeat(64) };
type Json = ReturnType<typeof JSON.parse>;

describe("attestation (IT-PUB-021)", () => {
  it("signs and verifies an OIDC attestation with source_verified and both hashes", async () => {
    const keys = await keySet();
    const signed = await signAttestation(oidcAttestation, await signerA());
    const wire = JSON.parse(JSON.stringify(signed));
    const result = await verifyAttestation(wire, {
      keys,
      expect: { pack: "@acme/gcp", version: "1.61021.1", upload_sha256: "a".repeat(64), canonical_sha256: "d".repeat(64) },
    });
    expect(result.ok).toBe(true);
    expect(wire).toMatchObject({ kid: "2026-10", rules_version: "2026.10.3", provenance: { source_verified: true } });
  });

  it("an upload attestation carries no repository claims and source_verified false", async () => {
    const keys = await keySet();
    const upload = { ...oidcAttestation, provenance: { source: "upload" as const, source_verified: false as const } };
    const signed = await signAttestation(upload, await signerA());
    expect((await verifyAttestation(signed, { keys, expect: expectOidc })).ok).toBe(true);
    await expect(signAttestation({ ...upload, provenance: { ...upload.provenance, repository: "acme/packs" } } as never, await signerA())).rejects.toThrow();
  });

  it("refuses a tampered hash, version, provenance or rules version", async () => {
    const keys = await keySet();
    const signed = await signAttestation(oidcAttestation, await signerA());
    const tampers: Array<(a: Json) => void> = [
      (a) => (a.canonical_sha256 = "e".repeat(64)),
      (a) => (a.upload_sha256 = "e".repeat(64)),
      (a) => (a.version = "9.9.9"),
      (a) => (a.provenance.source_verified = false),
      (a) => (a.provenance.commit = "c".repeat(40)),
      (a) => (a.rules_version = "2026.10.4"),
      (a) => (a.kid = "2027-04"),
    ];
    for (const t of tampers) {
      const bad = structuredClone(signed);
      t(bad);
      expect((await verifyAttestation(bad, { keys, expect: expectOidc })).ok).toBe(false);
    }
  });

  it("requires the caller to say which pack, version and canonical hash it expects", async () => {
    const keys = await keySet();
    const signed = await signAttestation(oidcAttestation, await signerA());
    // @ts-expect-error an expectation is mandatory
    await verifyAttestation(signed, { keys });
    // @ts-expect-error each of pack, version and canonical_sha256 is mandatory
    await verifyAttestation(signed, { keys, expect: { pack: "@acme/gcp" } });
    for (const missing of ["pack", "version", "canonical_sha256"] as const) {
      const partial: Record<string, string | undefined> = { ...expectOidc, [missing]: undefined };
      expect(await verifyAttestation(signed, { keys, expect: partial as typeof expectOidc })).toMatchObject({ ok: false, code: "mismatch" });
    }
    expect(await verifyAttestation(signed, { keys, expect: { ...expectOidc, pack: "@acme/other" } })).toMatchObject({ ok: false, code: "mismatch" });
    expect(await verifyAttestation(signed, { keys, expect: { ...expectOidc, version: "9.9.9" } })).toMatchObject({ ok: false, code: "mismatch" });
    expect(await verifyAttestation(signed, { keys, expect: { ...expectOidc, upload_sha256: "0".repeat(64) } })).toMatchObject({ ok: false, code: "mismatch" });
  });

  it("refuses unsigned, extra-field and non-attestation input", async () => {
    const keys = await keySet();
    const signed = await signAttestation(oidcAttestation, await signerA());
    const unsigned: Record<string, unknown> = { ...signed };
    delete unsigned.signature;
    expect(await verifyAttestation(unsigned, { keys, expect: expectOidc })).toMatchObject({ ok: false });
    expect(await verifyAttestation({ ...signed, extra: 1 }, { keys, expect: expectOidc })).toMatchObject({ ok: false });
    expect(await verifyAttestation(null, { keys, expect: expectOidc })).toMatchObject({ ok: false });
    expect(await verifyAttestation({ signature: "x" }, { keys, expect: expectOidc })).toMatchObject({ ok: false });
  });

  it("refuses an attestation for a different artifact than the caller expects", async () => {
    const keys = await keySet();
    const signed = await signAttestation(oidcAttestation, await signerA());
    expect(await verifyAttestation(signed, { keys, expect: { ...expectOidc, canonical_sha256: "0".repeat(64) } })).toMatchObject({ ok: false, code: "mismatch" });
  });

  it("refuses a kid the signer does not hold, and an unknown or revoked kid at verification", async () => {
    await expect(signAttestation(oidcAttestation, await signerB())).rejects.toThrow();
    const keys = await keySet();
    const stranger = await createSigner({ kid: "evil", seed: new Uint8Array(32).fill(1) });
    const forged = await signAttestation({ ...oidcAttestation, kid: "evil" }, stranger);
    expect(await verifyAttestation(forged, { keys, expect: expectOidc })).toMatchObject({ ok: false, code: "unknown-kid" });

    const signed = await signAttestation(oidcAttestation, await signerA());
    const rotated = promoteStandby(keys, { now: NOW, nextStandby: await nextStandby() });
    expect(await verifyAttestation(signed, { keys: rotated, expect: expectOidc })).toMatchObject({ ok: false, code: "revoked-kid" });
  });
});
