import { describe, expect, it } from "vitest";
import {
  SearchRequest,
  SearchResponse,
  SignAndWriteRootRequest,
  SignScopeIndexRequest,
  StartValidationRequest,
  StartValidationResponse,
  TreeFetchRequest,
  TreeFetchResponse,
  WizardUploadResponse,
  SignPrivateEntriesRequest,
} from "./service-bindings";
import * as f from "../shapes/fixtures";

const unsigned = <T extends object>(doc: T): Omit<T, "kid" | "signature"> => {
  const copy: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  delete copy.kid;
  delete copy.signature;
  return copy as Omit<T, "kid" | "signature">;
};
const unsignedRoot = unsigned(f.root);
const unsignedScope = unsigned(f.scopeIndex);
const unsignedPrivate = unsigned(f.privateEntry);

describe("service-binding contracts", () => {
  it("publish -> validator start", () => {
    const req = { run_id: "r", pack: "@acme/gcp", version: "1.0.0", staging_key: "staging/acme/gcp/1.0.0/c.tar.zst", declared_sha256: f.indexVersion.sha256, dry_run: false, source: "oidc", credential_id: "c" };
    expect(StartValidationRequest.safeParse(req).success).toBe(true);
    expect(StartValidationRequest.safeParse({ ...req, declared_sha256: "short" }).success).toBe(false);
    expect(StartValidationRequest.safeParse({ ...req, source: "email" }).success).toBe(false);
    expect(StartValidationResponse.safeParse({ ok: true, run_id: "r", workflow_instance_id: "w" }).success).toBe(true);
    expect(StartValidationResponse.safeParse({ ok: false, refusal: { reason: "quota" } }).success).toBe(true);
    expect(StartValidationResponse.safeParse({ ok: false, refusal: { reason: "nope" } }).success).toBe(false);
    expect(StartValidationResponse.safeParse({ ok: true }).success).toBe(false);
  });
  it("web -> mcp search cards carry a verdict value and the score parts", () => {
    const card = {
      id: "@acme/gcp", pitch: "p", inventory_counts: { skills: 1 }, context_cost: 100, verified: true,
      verified_domain: null, verified_github_org: null, verdict: "pass", repository: null, rating: null, score: 80,
      score_parts: [{ part: "context", weight: 25, points: 20, rules: [] }], newest_eligible: null,
    };
    expect(SearchResponse.safeParse({ cards: [card], degraded: false }).success).toBe(true);
    expect(SearchResponse.safeParse({ cards: [{ ...card, verdict: "ok" }], degraded: false }).success).toBe(false);
    expect(SearchResponse.safeParse({ cards: [{ ...card, score_parts: undefined }], degraded: false }).success).toBe(false);
  });
  it("web -> mcp search", () => {
    expect(SearchRequest.safeParse({ query: "gcp", limit: 10 }).success).toBe(true);
    expect(SearchRequest.safeParse({ query: "" }).success).toBe(false);
    expect(SearchRequest.safeParse({ query: "x", limit: 500 }).success).toBe(false);
  });
  it("web -> publish uploads", () => {
    expect(WizardUploadResponse.safeParse({ ok: true, upload_url: "https://r2.example/x", expires_at: "2026-10-22T10:05:00.000Z" }).success).toBe(true);
    expect(WizardUploadResponse.safeParse({ ok: true, upload_url: "not a url" }).success).toBe(false);
  });
  it("validator -> github tree fetch", () => {
    const req = { repository_id: 1, commit: "b".repeat(40), path: "packs/gcp" };
    expect(TreeFetchRequest.safeParse(req).success).toBe(true);
    expect(TreeFetchRequest.safeParse({ ...req, commit: "main" }).success).toBe(false);
    expect(TreeFetchResponse.safeParse({ status: "unreachable" }).success).toBe(true);
    expect(TreeFetchResponse.safeParse({ status: "found" }).success).toBe(false);
    expect(TreeFetchResponse.safeParse({ status: "found", tree_hash: f.indexVersion.sha256, file_count: 0 }).success).toBe(true);
  });
  it("coordinator -> validator sign requests carry unsigned documents only", () => {
    expect(SignScopeIndexRequest.safeParse({ scope: "acme", unsigned: unsignedScope }).success).toBe(true);
    expect(SignAndWriteRootRequest.safeParse({ unsigned: unsignedRoot }).success).toBe(true);
    expect(SignPrivateEntriesRequest.safeParse({ scope: "acme", entries: [unsignedPrivate] }).success).toBe(true);
    const otherScope = { ...unsignedScope, scope: "evil" };
    expect(SignScopeIndexRequest.safeParse({ scope: "acme", unsigned: otherScope }).success).toBe(false);
    const foreign = { ...unsignedPrivate, pack: "@evil/internal" };
    expect(SignPrivateEntriesRequest.safeParse({ scope: "acme", entries: [foreign] }).success).toBe(false);
    // a document of the wrong kind, or with a bad expiry, is refused before it can be signed
    expect(SignAndWriteRootRequest.safeParse({ unsigned: unsignedScope }).success).toBe(false);
    expect(SignScopeIndexRequest.safeParse({ scope: "acme", unsigned: { ...unsignedScope, expires: unsignedScope.generated_at } }).success).toBe(false);
  });
});
