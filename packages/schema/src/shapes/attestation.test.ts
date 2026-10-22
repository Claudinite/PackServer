import { describe, expect, it } from "vitest";
import { Attestation } from "./attestation";
import * as f from "./fixtures";

describe("attestation", () => {
  it("accepts an OIDC attestation", () => expect(Attestation.safeParse(f.attestation).success).toBe(true));
  it("accepts an upload attestation with no repository claims", () => {
    const doc = { ...f.attestation, provenance: { source: "upload", source_verified: false } };
    expect(Attestation.safeParse(doc).success).toBe(true);
  });
  it("rejects an upload that claims to be source-verified", () => {
    const doc = { ...f.attestation, provenance: { source: "upload", source_verified: true } };
    expect(Attestation.safeParse(doc).success).toBe(false);
  });
  it("rejects an upload provenance that smuggles repository claims", () => {
    const provenance = { source: "upload", source_verified: false, repository: "acme/packs" };
    expect(Attestation.safeParse({ ...f.attestation, provenance }).success).toBe(false);
  });
  it("rejects an OIDC provenance missing its repository id or with a short commit", () => {
    const rest: Record<string, unknown> = { ...f.attestation.provenance };
    delete rest.repository_id;
    expect(Attestation.safeParse({ ...f.attestation, provenance: rest }).success).toBe(false);
    expect(Attestation.safeParse({ ...f.attestation, provenance: { ...f.attestation.provenance, commit: "abc" } }).success).toBe(false);
  });
  it("rejects a tampered canonical hash and a missing kid", () => {
    expect(Attestation.safeParse({ ...f.attestation, canonical_sha256: "nope" }).success).toBe(false);
    expect(Attestation.safeParse({ ...f.attestation, kid: "" }).success).toBe(false);
  });
});
