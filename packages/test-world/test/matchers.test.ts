import { describe, expect, it } from "vitest";
import "../world/matchers";
import { Held, Ignored, NotFound, Refusal } from "../world/outcomes";

const resolves = <T>(v: T) => Promise.resolve(v);

describe("refusals", () => {
  it("toBeRefused reads a value, a promise of one, or a thrown refusal, with an optional reason", async () => {
    await expect(resolves(new Refusal("step-up"))).toBeRefused("step-up");
    await expect(new Refusal("quota")).toBeRefused();
    await expect(Promise.reject(new Refusal("forbidden"))).toBeRefused("forbidden");
    await expect(resolves(new Refusal("quota"))).not.toBeRefused("step-up");
    await expect(resolves({ ok: true })).not.toBeRefused();
  });

  it("does not swallow an infrastructure failure", async () => {
    await expect(expect(Promise.reject(new Error("harness down"))).toBeRefused()).rejects.toThrow("harness down");
  });

  it("names the failure it saw", async () => {
    await expect(expect(resolves({ ok: true })).toBeRefused("step-up")).rejects.toThrow(/expected a refusal \(step-up\), got \{"ok":true\}/);
  });

  it("covers the specialised refusals", async () => {
    await expect(new Refusal("rate-limited")).toBeRateLimited();
    await expect(new Refusal("human-check")).toRequireHumanCheck();
    await expect(new Refusal("signature")).toBeRefusedForVerification();
    await expect(new Refusal("oidc.fork", { claimDiff: ["fork"] })).toBeRefusedWithClaimDiff("fork");
    await expect(new Refusal("oidc.fork")).not.toBeRefusedWithClaimDiff("fork");
    await expect(new Refusal("oidc.fork", { claimDiff: ["workflow"] })).not.toBeRefusedWithClaimDiff("fork");
  });
});

describe("outcome shapes", () => {
  it("separates not found, ignored and held", async () => {
    await expect(resolves(new NotFound())).toBeNotFound();
    await expect(new Refusal("forbidden")).not.toBeNotFound();
    await expect(new Ignored()).toBeIgnored();
    await expect(new Held("quarantined")).toBeHeld("quarantined");
    await expect(new Held("quarantined")).not.toBeHeld("other");
  });
});

describe("collections and observations", () => {
  it("finds packs, versions, mail and audit actions", async () => {
    await expect({ packs: [{ name: "@acme/gcp" }] }).toContainPack({ name: "@acme/gcp" });
    await expect([{ name: "@acme/gcp" }]).not.toContainPack({ name: "@acme/aws" });
    await expect({ name: "@acme/gcp" }).toBePack({ name: "@acme/gcp" });
    await expect({ versions: [{ pack: "@acme/gcp", version: "1.0.0" }] }).toContainVersion({ name: "@acme/gcp" }, "1.0.0");
    await expect({ all: () => [{ subject: "Your pack was yanked", text: "", links: [] }] }).toContainEmail({ about: "yanked" });
    await expect({ all: () => [] }).not.toContainEmail({ about: "yanked" });
    await expect([{ action: "token.mint" }]).toContainAction("token.mint");
  });

  it("compares two observations by status, headers and body", async () => {
    const a = { status: 404, headers: { "content-type": "text/plain" }, body: "Not Found" };
    await expect(a).toLookTheSameAs({ ...a });
    await expect(a).not.toLookTheSameAs({ ...a, status: 403 });
  });

  it("asks a handle about itself for signatures, liveness and provenance", async () => {
    await expect({ verifies: async () => true }).toVerifyAgainst("key");
    await expect({ hasValidSignature: () => false }).not.toHaveValidSignature();
    await expect({ live: async () => true }).toBeLive();
    await expect({ provenance: async () => ({ repo: "acme/tool", ref: "refs/tags/v1", commit: "abc" }) }).toHaveProvenance({ repo: "acme/tool", ref: "refs/tags/v1" });
  });

  it("reads the telemetry sink, the recorder and the sandbox", async () => {
    const sink = { recorded: async () => [{ name: "publish.validated", attrs: { verdict: "pass", pack: "p" } }] };
    await expect(sink).toHaveRecorded("publish.validated", { verdict: "pass" });
    await expect(sink).not.toHaveRecorded("download");
    await expect([{ at: 1 }, { at: 2 }]).toHaveBeenAskedBefore({ at: 3 });
    await expect([{ at: 4 }]).not.toHaveBeenAskedBefore({ at: 3 });
    await expect([]).not.toHaveBeenAsked();
    await expect([{ egress_attempts: [] }]).toHaveAttemptedNoEgress();
    await expect([]).not.toHaveAttemptedNoEgress();
    await expect([{ egress_attempts: ["evil.example"] }]).not.toHaveAttemptedNoEgress();
  });

  it("expect.redacted matches the Recorder's placeholder for a class, never the value", () => {
    expect({ email: "<redacted:personal:ab12>", token: "<secret:x>" }).toMatchObject({
      email: expect.redacted("personal"),
      token: expect.redacted("secret"),
    });
    expect({ email: "ann@example.test" }).not.toMatchObject({ email: expect.redacted("personal") });
  });
});
