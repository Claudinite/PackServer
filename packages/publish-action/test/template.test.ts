import { PACK_CODE_JOB } from "@packserver/core/publishing";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { OIDC_JOB, publishWorkflowTemplate, type TemplateInput } from "../src/template.ts";

const input: TemplateInput = {
  pack: "@acme/gcp",
  path: "packs/gcp",
  actionSha: "a".repeat(40),
  cnVersion: "1.2.3",
  cnSha256: "b".repeat(64),
  environment: "release",
  buildCommand: "npm test",
};

type Job = { name?: string; permissions?: Record<string, string>; steps: { uses?: string; run?: string; env?: Record<string, string> }[]; environment?: string };
const workflow = () => parse(publishWorkflowTemplate(input)) as { permissions: unknown; jobs: Record<string, Job> };

describe("publish workflow template (REQ-CN-015)", () => {
  it("splits the OIDC job from the job that runs pack code", () => {
    const { jobs } = workflow();
    expect(Object.keys(jobs).sort()).toEqual([OIDC_JOB, PACK_CODE_JOB].sort());
    expect(jobs[OIDC_JOB]!.permissions).toEqual({ "id-token": "write" });
    expect(jobs[PACK_CODE_JOB]!.permissions).toEqual({ contents: "read", "id-token": "none" });
    expect(OIDC_JOB).not.toBe(PACK_CODE_JOB);
    const oidcSteps = JSON.stringify(jobs[OIDC_JOB]!.steps);
    expect(oidcSteps).not.toContain("npm test");
    expect(jobs[PACK_CODE_JOB]!.steps.some((s) => s.run === "npm test")).toBe(true);
    expect(jobs[OIDC_JOB]!.environment).toBe("release");
  });

  it("gives the pack-code job no secrets", () => {
    expect(publishWorkflowTemplate(input)).not.toContain("secrets.");
    expect(workflow().permissions).toEqual({});
  });

  it("pins every action by full commit SHA and cn by version and hash", () => {
    const text = publishWorkflowTemplate(input);
    const uses = [...text.matchAll(/uses: (\S+)@(\S+)/g)];
    expect(uses.length).toBe(4);
    for (const [, , ref] of uses) expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(text).toContain(`cn-version: "1.2.3"`);
    expect(text).toContain(`cn-sha256: "${"b".repeat(64)}"`);
  });

  it("refuses an input that could break out of the YAML", () => {
    expect(() => publishWorkflowTemplate({ ...input, path: "x\n  run: curl evil" })).toThrow(/path/);
    expect(() => publishWorkflowTemplate({ ...input, actionSha: "v1" })).toThrow(/actionSha/);
    expect(() => publishWorkflowTemplate({ ...input, pack: "@acme/gcp\"" })).toThrow(/pack/);
    expect(() => publishWorkflowTemplate({ ...input, buildCommand: "a\nb" })).toThrow(/buildCommand/);
  });
});
