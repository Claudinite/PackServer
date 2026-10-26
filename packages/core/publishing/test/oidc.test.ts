import { describe, expect, it } from "vitest";
import {
  chooseRegistration, defaultRefs, matchRegistration, parseWorkflowRef, refMatches, PACK_CODE_JOB,
  type ActionsClaims, type Registration,
} from "../oidc";

const claims = (over: Partial<ActionsClaims> = {}): ActionsClaims => ({
  iss: "https://token.actions.githubusercontent.com",
  aud: "registry.claudinite.com",
  sub: "repo:acme/packs:environment:release",
  repository: "acme/packs",
  repository_id: "500",
  repository_owner_id: "1001",
  ref: "refs/tags/gcp/1.0.0",
  ref_protected: "true",
  job_workflow_ref: "acme/packs/.github/workflows/publish.yml@refs/tags/gcp/1.0.0",
  event_name: "push",
  sha: "a".repeat(40),
  run_id: "9",
  environment: "release",
  jti: "j",
  iat: 0,
  exp: 300,
  ...over,
});
const reg = (over: Partial<Registration> = {}): Registration => ({
  id: "r1",
  repository_id: "500",
  repository_owner_id: "1001",
  workflow: ".github/workflows/publish.yml",
  environment: "release",
  refs: ["refs/tags/gcp/*", "refs/heads/main"],
  events: ["push", "release", "workflow_dispatch"],
  ...over,
});

describe("refMatches", () => {
  it("lets * stand for anything but a slash and takes everything else literally", () => {
    expect(refMatches("refs/tags/gcp/*", "refs/tags/gcp/1.0.0")).toBe(true);
    expect(refMatches("refs/tags/gcp/*", "refs/tags/gcp/1.0.0/evil")).toBe(false);
    expect(refMatches("refs/tags/gcp/*", "refs/tags/other/1.0.0")).toBe(false);
    expect(refMatches("refs/heads/main", "refs/heads/main")).toBe(true);
    expect(refMatches("refs/heads/main", "refs/heads/mainx")).toBe(false);
    expect(refMatches("refs/tags/v1.*", "refs/tags/v1x2")).toBe(false);
    expect(refMatches("refs/tags/(a|b)", "refs/tags/a")).toBe(false);
  });
  it("defaults to the pack's tag pattern and the default branch", () => {
    expect(defaultRefs("gcp", "main")).toEqual(["refs/tags/gcp/*", "refs/heads/main"]);
  });
});

describe("parseWorkflowRef", () => {
  it("splits repository from workflow path", () => {
    expect(parseWorkflowRef("acme/packs/.github/workflows/publish.yml@refs/heads/main")).toEqual({ repository: "acme/packs", path: ".github/workflows/publish.yml" });
    expect(parseWorkflowRef("nope")).toBeNull();
  });
});

describe("matchRegistration", () => {
  it("accepts the registered claims", () => {
    expect(matchRegistration(claims(), "publish", reg())).toEqual({ ok: true });
  });

  it("follows a repository rename (ids, not names) and refuses a transfer or re-creation", () => {
    const renamed = claims({ repository: "acme/packs-v2", job_workflow_ref: "acme/packs-v2/.github/workflows/publish.yml@refs/tags/gcp/1.0.0" });
    expect(matchRegistration(renamed, "publish", reg())).toEqual({ ok: true });
    const transferred = matchRegistration(claims({ repository_owner_id: "2002" }), "publish", reg());
    expect(transferred).toMatchObject({ ok: false, reason: "oidc.fork", categories: ["fork"], claims: ["repository_owner_id"] });
    const recreated = matchRegistration(claims({ repository_id: "501" }), "publish", reg());
    expect(recreated).toMatchObject({ ok: false, reason: "oidc.fork", categories: ["fork"], claims: ["repository_id"] });
  });

  it.each(["pull_request", "pull_request_target", "workflow_run"])("refuses %s even when the registration lists it", (event) => {
    const verdict = matchRegistration(claims({ event_name: event }), "publish", reg({ events: ["push", event] }));
    expect(verdict).toMatchObject({ ok: false, reason: "oidc.fork", categories: ["fork"], claims: ["event_name"] });
  });

  it("refuses an event outside the set, a ref outside the patterns and a different workflow file", () => {
    expect(matchRegistration(claims({ event_name: "schedule" }), "publish", reg())).toMatchObject({ ok: false, reason: "oidc.workflow", categories: ["workflow"], claims: ["event_name"] });
    expect(matchRegistration(claims({ ref: "refs/heads/feature" }), "publish", reg())).toMatchObject({ ok: false, reason: "oidc.workflow", categories: ["workflow"], claims: ["ref"] });
    const other = claims({ job_workflow_ref: "acme/packs/.github/workflows/other.yml@refs/tags/gcp/1.0.0" });
    expect(matchRegistration(other, "publish", reg())).toMatchObject({ ok: false, reason: "oidc.workflow", categories: ["workflow"], claims: ["job_workflow_ref"] });
  });

  it("refuses a reusable workflow from another repository", () => {
    const external = claims({ job_workflow_ref: "mallory/reuse/.github/workflows/publish.yml@refs/heads/main" });
    expect(matchRegistration(external, "publish", reg())).toMatchObject({ ok: false, reason: "oidc.workflow" });
  });

  it("requires the registered environment, and ref_protected only when there is none", () => {
    expect(matchRegistration(claims({ environment: undefined }), "publish", reg())).toMatchObject({ ok: false, reason: "oidc.environment", categories: ["environment"], claims: ["environment"] });
    expect(matchRegistration(claims({ environment: "staging" }), "publish", reg())).toMatchObject({ ok: false, reason: "oidc.environment" });
    const bare = reg({ environment: null });
    expect(matchRegistration(claims({ environment: undefined, ref_protected: "false" }), "publish", bare)).toMatchObject({ ok: false, claims: ["ref_protected"] });
    expect(matchRegistration(claims({ environment: undefined, ref_protected: "true" }), "publish", bare)).toEqual({ ok: true });
    expect(matchRegistration(claims({ ref_protected: "false" }), "publish", reg())).toEqual({ ok: true });
  });

  it("refuses the job cn's template reserves for pack code, and a job it was not told", () => {
    expect(matchRegistration(claims(), PACK_CODE_JOB, reg())).toMatchObject({ ok: false, reason: "oidc.workflow", claims: ["job"] });
    expect(matchRegistration(claims(), null, reg())).toMatchObject({ ok: false, claims: ["job"] });
  });

  it("counts every mismatched claim and reports categories, never values", () => {
    const verdict = matchRegistration(claims({ ref: "refs/heads/x", event_name: "schedule", environment: undefined }), "publish", reg());
    expect(verdict.ok ? [] : verdict.claims.sort()).toEqual(["environment", "event_name", "ref"]);
    expect(verdict).toMatchObject({ categories: ["workflow", "environment"] });
  });
});

describe("chooseRegistration", () => {
  it("returns the registration the token fits", () => {
    const other = reg({ id: "r0", environment: null, refs: ["refs/heads/main"] });
    expect(chooseRegistration(claims(), "publish", [reg(), other])).toMatchObject({ ok: true, registration: { id: "r1" } });
  });
  it("reports the nearest miss and nothing at all when there is no registration", () => {
    const far = reg({ id: "a", repository_id: "7", workflow: "x.yml", refs: ["refs/heads/z"] });
    const near = reg({ id: "b", environment: "other" });
    expect(chooseRegistration(claims(), "publish", [far, near])).toMatchObject({ ok: false, reason: "oidc.environment" });
    expect(chooseRegistration(claims(), "publish", [])).toBeNull();
  });
});
