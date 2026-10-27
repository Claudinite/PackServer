import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drift, main, managedFiles, stage } from "./witness-apply.mjs";

const lines = (argv) => {
  const out = [];
  const code = main(argv, (l) => out.push(l));
  return { code, text: out.join("\n") };
};

describe("witness-apply", () => {
  it("carries the config, the workflow and the reporter, and no tests", () => {
    expect(managedFiles()).toEqual([".github/workflows/witness-report.yml", ".upptimerc.yml", "scripts/witness-report.mjs"]);
  });

  it("stages into a directory and reports it in sync, then drifted after an edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "witness-"));
    expect(drift(dir)).toHaveLength(3);
    stage(dir);
    expect(drift(dir)).toEqual([]);
    writeFileSync(join(dir, ".upptimerc.yml"), "changed");
    expect(drift(dir)).toEqual([".upptimerc.yml"]);
    expect(lines(["--check", dir]).code).toBe(1);
  });

  it("ignores template files it does not own", () => {
    const dir = mkdtempSync(join(tmpdir(), "witness-"));
    stage(dir);
    writeFileSync(join(dir, "README.md"), "from the Upptime template");
    expect(drift(dir)).toEqual([]);
  });

  it("lists the secrets and the human steps without writing anything by default", () => {
    const { code, text } = lines([]);
    expect(code).toBe(0);
    for (const name of ["WITNESS_HOOK_SECRET", "CF_ANALYTICS_READ_TOKEN", "PUSHOVER_USER_KEY"]) expect(text).toContain(name);
    expect(text).toContain("Would stage");
    expect(text).toContain("main-protection");
    expect(text).toContain("PUBLIC repository from the upptime/upptime template");
  });
});
