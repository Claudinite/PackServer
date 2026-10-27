import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratedD1 } from "@packserver/core/identity/testing";
import { PROBE_PACK, PROBE_REPOSITORY_NAME, PROBE_SCOPE, PROBE_WORKFLOW, provisionProbeTenant } from "@packserver/core/synthetic";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { ProbeResult } from "../../judge/src/api/routes";

const path = join(import.meta.dirname, "..", "probe-repo", "probe-dry-run.yml");
const text = readFileSync(path, "utf8");
type Step = { id?: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> };
type Job = { if?: string; permissions: Record<string, string>; needs?: string; steps: Step[] };
const workflow = parse(text) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };

describe("the dry-run workflow template", () => {
  it("is the workflow the probe tenant registers, on the events it registers", async () => {
    expect(PROBE_WORKFLOW.endsWith("/probe-dry-run.yml")).toBe(true);
    const { d1 } = migratedD1();
    await provisionProbeTenant(d1, { repository: { slug: `Claudinite/${PROBE_REPOSITORY_NAME}`, id: "9001", ownerId: "42" }, nowMs: Date.now() });
    const row = (await d1.query(`select pack_name, workflow, events, refs from trusted_publishers`)).rows[0] as { pack_name: string; workflow: string; events: string; refs: string };
    expect(row.pack_name).toBe(PROBE_PACK);
    expect(row.workflow).toBe(PROBE_WORKFLOW);
    expect(Object.keys(workflow.on).sort()).toEqual((JSON.parse(row.events) as string[]).sort());
    expect(JSON.parse(row.refs)).toEqual(["refs/heads/main"]);
    expect(text).toContain(`"@${PROBE_SCOPE}/${PROBE_PACK}"`);
  });

  it("runs only in the probe repository, and grants a token to the publishing job alone", () => {
    const guard = `github.repository == 'Claudinite/${PROBE_REPOSITORY_NAME}'`;
    expect(workflow.permissions).toEqual({});
    for (const [name, job] of Object.entries(workflow.jobs)) expect(job.if, name).toContain(guard);
    expect(Object.entries(workflow.jobs).filter(([, j]) => j.permissions["id-token"] === "write").map(([n]) => n)).toEqual(["publish"]);
    expect(workflow.jobs.report!.permissions).toEqual({});
    expect(JSON.stringify(workflow.jobs.publish)).not.toContain("secrets.");
  });

  it("names three values to fill in, and the header lists them", () => {
    const placeholders = [...text.matchAll(/\b(PUBLISH_PACK_SHA|CN_VERSION|CN_SHA256)\b/g)].map((m) => m[1]);
    expect(new Set(placeholders)).toEqual(new Set(["PUBLISH_PACK_SHA", "CN_VERSION", "CN_SHA256"]));
    const header = text.slice(0, text.indexOf("\nname:"));
    for (const word of ["PUBLISH_PACK_SHA", "CN_VERSION", "CN_SHA256"]) expect(header).toContain(`#   ${word}`);
  });

  it("publishes a version no re-run of an earlier run can repeat", () => {
    const script = workflow.jobs.publish!.steps.find((s) => s.id === "pack")!.run!;
    expect(script).toContain("${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}");
    expect(script).not.toContain("RUN_NUMBER");
  });

  it("does not write to GitHub", () => {
    expect(text).not.toMatch(/gh (api|pr|issue)|api\.github\.com|contents: write|pull-requests: write|issues: write/);
  });

  describe("reporting", () => {
    const script = workflow.jobs.report!.steps.find((s) => s.run)!.run!;
    const dir = mkdtempSync(join(tmpdir(), "probe-report-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const posted = join(dir, "posted.json");
    // A curl that answers the self-test with a version and keeps what is posted, so the script's own jq and bash run for real.
    writeFileSync(join(dir, "curl"), `#!/bin/bash\ncase "$*" in\n  *__selftest*) echo '{"version_id":"${process.env.SELFTEST_VERSION ?? "abc-123"}"}' ;;\n  *) cat > "${posted}" ;;\nesac\n`);
    chmodSync(join(dir, "curl"), 0o755);

    const report = (verdict: string): { status: number | null; body: unknown } => {
      writeFileSync(posted, "");
      const r = spawnSync("bash", ["-e", "-c", script], {
        env: { PATH: `${dir}:${process.env.PATH}`, VERDICT: verdict, RUN_ID: "77-1", CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret", CANARY_ORIGIN: "https://canary.test" },
        encoding: "utf8",
      });
      const body = readFileSync(posted, "utf8");
      return { status: r.status, body: body ? JSON.parse(body) : null };
    };

    it.each([
      ["pass", true, false],
      ["warn", true, false],
      ["hold", true, false],
      ["fail", true, false],
      ["error", false, true],
      ["", false, true],
    ])("posts a result the judge accepts for the verdict %j", (verdict, reached, failed) => {
      const { status, body } = report(verdict);
      expect(status).toBe(0);
      expect(ProbeResult.parse(body)).toEqual({ kind: "publish.dry_run", version_id: "abc-123", run_id: "77-1", reached_verdict: reached, publish_failed: failed });
    });

    it("posts nothing for a run the registry queued", () => {
      expect(report("queued")).toEqual({ status: 0, body: null });
    });
  });
});
