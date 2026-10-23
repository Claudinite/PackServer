import { describe, expect, it } from "vitest";
import { extractedParts, undeclaredParts, readManifest } from "../index.ts";
import { runStaticRules } from "../index.ts";
import { cleanFiles, fakePorts, input, make, manifestJson, treeOf } from "./helpers.ts";

const run = (files: Record<string, string>, over = {}, ports = fakePorts()) => runStaticRules(input(files, over), ports);
const rulesOf = (r: { findings: { rule: string }[] }) => r.findings.map((f) => f.rule);

describe("manifest (IT-VAL-004, IT-VAL-007)", () => {
  it("fails a missing pack.json", async () => {
    const rest = cleanFiles();
    delete rest["pack.json"];
    expect(rulesOf(await run(rest))).toContain("manifest.missing");
  });

  it("fails invalid JSON and a schema mismatch", async () => {
    expect(rulesOf(await run(cleanFiles({ "pack.json": "{nope" })))).toEqual(["manifest.malformed"]);
    expect(rulesOf(await run(cleanFiles({ "pack.json": JSON.stringify({ version: 1 }) })))).toEqual(["manifest.malformed"]);
    expect(rulesOf(await run(cleanFiles({ "pack.json": "[]" })))).toEqual(["manifest.malformed"]);
  });

  it("fails a version that is not x.y.z", async () => {
    for (const version of ["1.2", "v1.0.0", "1.0.0-beta", "01.0.0", "1.0.0.0"]) {
      expect(rulesOf(await run(cleanFiles({ "pack.json": manifestJson({ version }) }))), version).toContain("manifest.version-not-semver");
    }
    expect(rulesOf(await run(cleanFiles({ "pack.json": manifestJson({ version: "1.61004.1" }) })))).toEqual([]);
  });

  it("fails a version that is not greater than the newest, comparing numerically", async () => {
    const files = cleanFiles({ "pack.json": manifestJson({ version: "1.0.9" }) });
    expect(rulesOf(await run(files, { newestVersion: "1.0.10" }))).toEqual(["manifest.version-not-greater"]);
    expect(rulesOf(await run(files, { newestVersion: "1.0.9" }))).toEqual(["manifest.version-not-greater"]);
    expect(rulesOf(await run(files, { newestVersion: "1.0.8" }))).toEqual([]);
  });

  it("fails a minEngineVersion that is not three-part", async () => {
    const r = await run(cleanFiles({ "pack.json": manifestJson({ minEngineVersion: "1.61" }) }));
    expect(rulesOf(r)).toEqual(["manifest.min-engine-invalid"]);
  });

  it("answers an unreadable and a nonexistent requires alike, and passes a published one", async () => {
    const ports = fakePorts({ readable: ["@acme/gcp"] });
    const asked: string[] = [];
    const spy = { ...ports, canRead: async (n: string) => (asked.push(n), ports.canRead(n)) };
    const nobody = await run(cleanFiles({ "pack.json": manifestJson({ requires: ["@nobody/none"] }) }), {}, spy);
    const secret = await run(cleanFiles({ "pack.json": manifestJson({ requires: ["@acme/secret"] }) }), {}, spy);
    expect(rulesOf(nobody)).toEqual(["manifest.requires-unresolved"]);
    expect(rulesOf(secret)).toEqual(["manifest.requires-unresolved"]);
    expect(nobody.findings[0]!.hint.replace("@nobody/none", "X")).toBe(secret.findings[0]!.hint.replace("@acme/secret", "X"));
    expect(rulesOf(await run(cleanFiles({ "pack.json": manifestJson({ requires: ["@acme/gcp"] }) }), {}, spy))).toEqual([]);
    const bad = await run(cleanFiles({ "pack.json": manifestJson({ requires: ["not a name"] }) }), {}, spy);
    expect(rulesOf(bad)).toEqual(["manifest.requires-unresolved"]);
    expect(asked).toContain("@invalid/invalid");
  });

  it("fails a declared part that the archive lacks (D53) and shows an undeclared one as extracted", async () => {
    const files = cleanFiles({
      "pack.json": manifestJson({ skills: ["a", "ghost"], tasks: ["t"], checks: ["c"] }),
      "skills/a/SKILL.md": "---\nname: a\n---\n",
      "tasks/t/task.json": "{}",
      "checks/c.go": "package main\n",
    });
    const r = await run(files);
    expect(r.findings.filter((f) => f.rule === "manifest.declared-part-missing")).toHaveLength(1);
    expect(r.findings[0]!.hint).toContain("ghost");

    const extra = cleanFiles({ "pack.json": manifestJson({ skills: ["a"] }), "skills/a/SKILL.md": "x", "skills/b/SKILL.md": "y" });
    const warned = await run(extra);
    expect(rulesOf(warned)).toEqual(["manifest.undeclared-part"]);
    expect(warned.findings[0]).toMatchObject({ class: "warn", file: "pack.json" });
    expect(warned.findings[0]!.hint).toContain('"b"');
    const tree = treeOf(extra);
    const read = readManifest(tree, make);
    expect(read.ok && undeclaredParts(tree, read.manifest)).toEqual([{ kind: "skills", name: "b" }]);
    expect(extractedParts(tree).skills).toEqual(["a", "b"]);
  });

  it("claims nothing for a part kind pack.json does not list, and accepts object guidance fields", async () => {
    const files = cleanFiles({
      "pack.json": manifestJson({ ruleRoutingGuidance: { belongs: "x", excludes: "y" }, relevanceDetector: { about: "z", paths: "^a$" }, seededByDefault: true }),
      "skills/a/SKILL.md": "x",
    });
    expect(rulesOf(await run(files))).toEqual([]);
  });

  it("warns on a missing license, README and fixtures, and accepts a LICENSE file", async () => {
    const bare = { "pack.json": JSON.stringify({ version: "1.0.0", minEngineVersion: "1.0.0" }) };
    const r = await run(bare);
    expect(rulesOf(r).sort()).toEqual(["docs.readme-missing", "fixtures.missing", "license.missing"]);
    expect(r.findings.every((f) => f.class === "warn")).toBe(true);
    expect(rulesOf(await run({ ...bare, LICENSE: "MIT" }))).not.toContain("license.missing");
  });

  it("does not ask for fixtures from a pack with coded checks", async () => {
    const files = cleanFiles({ "checks/c.go": "package main\n" });
    delete (files as Record<string, string | undefined>)["fixtures/example.md"];
    expect(rulesOf(await run(files))).toEqual([]);
  });
});
