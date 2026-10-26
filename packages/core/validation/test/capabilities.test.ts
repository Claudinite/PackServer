import { describe, expect, it } from "vitest";
import type { CapabilitySet } from "@packserver/schema";
import { derivePreInstall, extractCapabilities, isWidening, readManifest, runStaticRules } from "../index.ts";
import { cleanFiles, fakePorts, input, make, manifestJson, treeOf } from "./helpers.ts";
import { GUARD_GO, pack, TASK_JSON, WORKER } from "./pack-fixtures.ts";

function extract(files: Record<string, string>) {
  const tree = treeOf(files);
  const read = readManifest(tree, make);
  return extractCapabilities(tree, read.ok ? read.manifest : null);
}

describe("capability extraction (REQ-VAL-027, IT-VAL-027)", () => {
  it("gives a prose-only pack the empty set", () => {
    const e = extract(pack("gcp"));
    expect(e.capabilities).toEqual([]);
    expect(e.preinstall).toEqual({ guards: [], tasks: [], forced_skills: [], github_actions: [] });
  });

  it("reads a declared check's guardToolCalls as a guard and the tools it judges", () => {
    const e = extract(pack("with-guard"));
    expect(e.capabilities).toEqual(["guard"]);
    expect(e.preinstall.guards).toEqual([{ name: "x/pre-deploy-guard", tool_calls: ["Bash"] }]);
  });

  it("reads declared checks as a top-level array or a checks list, and the per-skill files", () => {
    const entry = (id: string, tool: string) => ({ id, guardToolCalls: [{ tool }, { tool: "/^Edit$/" }] });
    const listed = extract({ ...cleanFiles(), "declared-checks.json": JSON.stringify({ checks: [entry("a", "Bash")] }) });
    expect(listed.preinstall.guards).toEqual([{ name: "a", tool_calls: ["/^Edit$/", "Bash"] }]);
    const skill = extract({ ...cleanFiles(), "skills/s/declared-checks.json": JSON.stringify([entry("b", "Write")]) });
    expect(skill.preinstall.guards.map((g) => g.name)).toEqual(["b"]);
    const plain = extract({ ...cleanFiles(), "declared-checks.json": JSON.stringify([{ id: "c", matchLines: [] }]) });
    expect(plain.capabilities).toEqual([]);
  });

  it("fails closed on a declared guard it cannot read", () => {
    for (const body of [{ id: "a", guardToolCalls: [] }, { id: "a", guardToolCalls: [{ nottool: 1 }] }, { id: "a", guardToolCalls: "Bash" }, { id: "a", guardsOn: ["Bash"] }, { id: "a", event: "PreToolUse" }]) {
      const e = extract({ ...cleanFiles(), "declared-checks.json": JSON.stringify([body]) });
      expect(e.preinstall.guards, JSON.stringify(body)).toEqual([{ name: "a", tool_calls: expect.arrayContaining(["*"]) }]);
    }
    const unreadable = extract({ ...cleanFiles(), "declared-checks.json": '[{"guardToolCalls": [' });
    expect(unreadable.capabilities).toEqual(["guard"]);
    expect(extract({ ...cleanFiles(), "declared-checks.json": "[" }).capabilities).toEqual([]);
  });

  it("makes a Go check tagged with a hook event a guard, whatever the SDK import is called", () => {
    const go = (imp: string, call: string, tags: string) => `package checks\nimport ${imp}\nfunc init() { ${call}(${imp.split(" ")[0] === '"claudinite.com/checksdk"' ? "checksdk" : "c"}.Check{ID: "p/g", Tags: ${tags}}) }\n`;
    const plainImp = '"claudinite.com/checksdk"';
    const g = extract({ ...cleanFiles(), "checks/a.go": go(plainImp, "checksdk.Register", '[]string{"PreToolUse:Bash|Edit", "world"}') });
    expect(g.capabilities).toEqual(["guard"]);
    expect(g.preinstall.guards).toEqual([{ name: "p/g", tool_calls: ["Bash", "Edit"] }]);
    const aliased = extract({ ...cleanFiles(), "checks/a.go": `package checks\nimport c "claudinite.com/checksdk"\nfunc init() { c.Register(c.Check{ID: "p/g", Tags: []string{"UserPromptSubmit"}}) }\n` });
    expect(aliased.capabilities).toEqual(["guard"]);
    expect(aliased.preinstall.guards).toEqual([{ name: "p/g", tool_calls: ["*"] }]);
    const both = extract({ ...cleanFiles(), "checks/a.go": `package checks\nfunc init() {\n checksdk.Register(checksdk.Check{ID: "p/a", Tags: []string{"world"}})\n checksdk.Register(checksdk.Check{ID: "p/b", Tags: []string{"PostToolUse"}})\n}\n` });
    expect(both.capabilities).toEqual(["coded-check", "guard"]);
  });

  it("fails closed on a Go check whose tags it cannot read or that hides its registration", () => {
    const cases = [
      'func init() { checksdk.Register(checksdk.Check{ID: "p/g", Tags: tags}) }',
      'func init() { checksdk.Register(checksdk.Check{ID: "p/g", Tags: append([]string{"world"}, extra...)}) }',
      'func init() { r := checksdk.Register; r(checksdk.Check{ID: "p/g", Tags: []string{"PreToolUse"}}) }',
      'var tag = "PreToolUse"\nfunc init() { checksdk.Register(checksdk.Check{ID: "p/g", Tags: []string{tag}}) }',
      'func init() { checksdk.RegisterHook(checksdk.PreToolUse, "Bash", f) }',
    ];
    for (const body of cases) {
      expect(extract({ ...cleanFiles(), "checks/a.go": `package checks\n${body}\n` }).capabilities, body).toContain("guard");
    }
  });

  it("is not fooled by a registration in a comment or a string", () => {
    const e = extract({ ...cleanFiles(), "checks/a.go": `package checks\n// checksdk.Register(checksdk.Check{Tags: []string{"PreToolUse"}})\nvar s = "RegisterHook"\n` });
    expect(e.capabilities).toEqual(["coded-check"]);
  });

  it("calls a check with only plain tags a coded check, not a guard", () => {
    expect(extract(pack("with-coded-check")).capabilities).toEqual(["coded-check"]);
    expect(extract({ ...cleanFiles(), "checks/g_test.go": GUARD_GO }).capabilities).toEqual([]);
  });

  it("reads a task's cadence and whether it opens PRs or has an agentic phase", () => {
    const e = extract(pack("with-task-opens-pr"));
    expect(e.capabilities).toEqual(["task", "task:opens-pr"]);
    expect(e.preinstall.tasks).toEqual([{ name: "rotate", cadence: "weekly", opens_pr: true, agentic_phase: false }]);
    const agentic = extract({ ...cleanFiles(), "tasks/t/task.json": TASK_JSON({ trigger: { cron: "0 3 * * 1" }, agent_instructions: "task.md" }) });
    expect(agentic.capabilities).toEqual(["task", "task:agentic-phase"]);
    expect(agentic.preinstall.tasks[0]).toMatchObject({ cadence: "0 3 * * 1", opens_pr: false, agentic_phase: true });
    const plain = extract({ ...cleanFiles(), "tasks/t/task.json": TASK_JSON({ pr: false }) });
    expect(plain.capabilities).toEqual(["task"]);
  });

  it("assumes the worst of a task.json it cannot read", () => {
    const e = extract({ ...cleanFiles(), "tasks/t/task.json": "{" });
    expect(e.capabilities).toEqual(["task", "task:agentic-phase", "task:opens-pr"]);
  });

  it("finds env setup by path or by pack.json", () => {
    expect(extract(pack("with-env-setup")).capabilities).toEqual(["env-setup"]);
    expect(extract({ ...cleanFiles(), "pack.json": manifestJson({ envSetup: "scripts/prep.sh" }) }).capabilities).toEqual(["env-setup"]);
    expect(extract({ ...cleanFiles(), "pack.json": manifestJson({ envSetup: false }) }).capabilities).toEqual([]);
  });

  it("finds a forced skill by its frontmatter, in any spelling that forces it", () => {
    const e = extract(pack("with-forced-skill"));
    expect(e.capabilities).toEqual(["forced-skill"]);
    expect(e.preinstall.forced_skills).toEqual(["deploy"]);
    for (const line of ["force-before: infra/**", "forceOn: [a]", "Forced: true", "forced:\n  - infra/**", "'forced': yes"]) {
      expect(extract({ ...cleanFiles(), "skills/s/SKILL.md": `---\r\nname: s\r\n${line}\r\n---\r\n` }).capabilities, line).toEqual(["forced-skill"]);
    }
    for (const line of ["forced: false", "forced: no", "forced: 'off'", "note: forced: true"]) {
      expect(extract({ ...cleanFiles(), "skills/s/SKILL.md": `---\nname: s\n${line}\n---\n` }).capabilities, line).toEqual([]);
    }
    expect(extract({ ...cleanFiles(), "skills/s/SKILL.md": "forced: true\n" }).capabilities).toEqual([]);
    expect(extract({ ...cleanFiles(), "pack.json": manifestJson({ forcedSkills: ["s"] }), "skills/s/SKILL.md": "x" }).capabilities).toEqual(["forced-skill"]);
  });

  it("lists the declared GitHub actions, normalised", () => {
    const e = extract({ ...cleanFiles(), "pack.json": manifestJson({ githubActions: ["Actions/Checkout@v4", "actions/checkout"] }) });
    expect(e.capabilities).toEqual(["github-action:actions/checkout"]);
    expect(e.preinstall.github_actions).toEqual(["actions/checkout"]);
  });

  it("counts an action used in a workflow or a task as part of the set, declared or not", () => {
    const e = extract({
      ...cleanFiles(),
      ".github/workflows/x.yml": "jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n      # - uses: commented/out\n      - uses: ./local\n",
      "tasks/t/task.json": TASK_JSON({ steps: [{ uses: "docker://alpine" }] }),
    });
    expect(e.capabilities).toEqual(["task", "github-action:actions/setup-node", "github-action:docker://alpine"].sort());
    expect(e.usedActions.map((u) => u.name).sort()).toEqual(["actions/setup-node", "docker://alpine"]);
  });

  it("holds every kind at once", () => {
    const e = extract(pack("with-guard", "with-coded-check", "with-task-opens-pr", "with-env-setup", "with-forced-skill", "with-github-action"));
    expect(e.capabilities).toEqual(["coded-check", "env-setup", "forced-skill", "github-action:actions/checkout", "guard", "task", "task:opens-pr"]);
  });
});

describe("the widening predicate (REQ-VAL-052, IT-VAL-052)", () => {
  const w = (prev: CapabilitySet | null, next: CapabilitySet) => isWidening(prev, next);
  it("widens on each executable capability the previous version lacked", () => {
    for (const c of ["guard", "coded-check", "task:opens-pr", "task:agentic-phase", "env-setup", "forced-skill", "github-action:actions/checkout"] as const) {
      expect(w([], [c]), c).toBe(true);
      expect(w([c], [c]), c).toBe(false);
    }
  });
  it("never widens on prose, or on a task with neither flag", () => {
    expect(w([], [])).toBe(false);
    expect(w([], ["task"])).toBe(false);
    expect(w(["task"], ["task", "task:opens-pr"])).toBe(true);
  });
  it("widens on a new action, not on a different order or a dropped capability", () => {
    expect(w(["guard", "github-action:a/b"], ["github-action:a/b", "github-action:c/d", "guard"])).toBe(true);
    expect(w(["guard", "env-setup"], ["guard"])).toBe(false);
  });
  it("treats no predecessor as an empty one", () => {
    expect(w(null, ["guard"])).toBe(true);
    expect(w(null, [])).toBe(false);
  });
});

describe("the pre-install manifest and its new marks (REQ-VAL-046, IT-VAL-046, JT-003)", () => {
  const derive = (files: Record<string, string>, prev: ReturnType<typeof derivePreInstall> | null) => derivePreInstall(extract(files), prev);

  it("marks nothing new on a prose-only first version, and everything on a first version with code", () => {
    expect(derive(pack("gcp"), null)).toMatchObject({ widening: false, preinstall: { new: [] }, capabilities: [] });
    expect(derive(pack("with-guard"), null).preinstall.new).toEqual(["guard:x/pre-deploy-guard"]);
  });

  it("marks the forced skill and the task new and the guard not, and widens", () => {
    const v1 = derive(pack("with-guard"), null);
    const files = { ...pack("with-guard", "with-forced-skill"), "tasks/rotate/task.json": TASK_JSON({ trigger: { schedule: "weekly" }, pr: { title: "x" } }), "tasks/rotate/worker.mjs": WORKER };
    const v2 = derive(files, v1);
    expect(v2.widening).toBe(true);
    expect(v2.preinstall.new.sort()).toEqual(["forced-skill:deploy", "task:rotate"]);
    expect(v2.preinstall).toMatchObject({
      guards: [{ name: "x/pre-deploy-guard", tool_calls: ["Bash"] }],
      tasks: [{ name: "rotate", cadence: "weekly", opens_pr: true, agentic_phase: false }],
      forced_skills: ["deploy"],
      github_actions: [],
    });
  });

  it("marks a guard new when it starts judging another tool, though the set is unchanged", () => {
    const v1 = derive(pack("with-guard"), null);
    const v2 = derive({ ...cleanFiles(), "declared-checks.json": JSON.stringify([{ id: "x/pre-deploy-guard", guardToolCalls: [{ tool: "Bash" }, { tool: "Write" }] }]) }, v1);
    expect(v2.preinstall.new).toEqual(["guard:x/pre-deploy-guard"]);
    expect(v2.widening).toBe(false);
  });

  it("marks coded checks, env setup and actions new, and a prose change not at all", () => {
    const v1 = derive(pack("gcp"), null);
    const v2 = derive(pack("with-coded-check", "with-env-setup", "with-github-action"), v1);
    expect(v2.preinstall.new.sort()).toEqual(["coded-check", "env-setup", "github-action:actions/checkout"]);
    const v3 = derive({ ...pack("with-coded-check", "with-env-setup", "with-github-action"), "RULES.md": "# Rules\n\n- changed\n" }, v2);
    expect(v3).toMatchObject({ widening: false, preinstall: { new: [] } });
  });

  it("marks a plain task new without widening, then a later action widening (@q/plain)", () => {
    const v1 = derive(pack("gcp"), null);
    const v2 = derive({ ...cleanFiles(), "tasks/t/task.json": TASK_JSON(), "tasks/t/worker.mjs": WORKER }, v1);
    expect(v2).toMatchObject({ widening: false, preinstall: { new: ["task:t"] } });
    const v3 = derive({ ...cleanFiles(), "tasks/t/task.json": TASK_JSON(), "tasks/t/worker.mjs": WORKER, "pack.json": manifestJson({ githubActions: ["actions/checkout"] }) }, v2);
    expect(v3).toMatchObject({ widening: true, preinstall: { new: ["github-action:actions/checkout"] } });
  });

  it("satisfies the shared PreInstallManifest shape", async () => {
    const { PreInstallManifest } = await import("@packserver/schema");
    const v = derive(pack("with-guard", "with-task-opens-pr", "with-forced-skill", "with-github-action"), null);
    expect(PreInstallManifest.safeParse(v.preinstall).success).toBe(true);
  });
});

describe("runStaticRules carries the capability set (IT-VAL-027)", () => {
  it("returns capabilities, manifest and widening beside the findings", async () => {
    const prev = derivePreInstall(extract(pack("with-guard")), null);
    const r = await runStaticRules(input(pack("with-guard", "with-task-opens-pr"), { previous: prev }), fakePorts());
    expect(r.findings).toEqual([]);
    expect(r.widening).toBe(true);
    expect(r.capabilities).toEqual(["guard", "task", "task:opens-pr"]);
    expect(r.preinstall.new).toEqual(["task:rotate"]);
    const prose = await runStaticRules(input(cleanFiles()), fakePorts());
    expect(prose).toMatchObject({ capabilities: [], widening: false });
  });
});
