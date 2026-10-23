import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { checkGate, checkTree, fsSource, scanScenarios } from "./check-scenarios.mjs";
import { checkSignals, signalsInCode, signalsInDoc } from "./check-signals.mjs";
import { exemptIds, judge, newScenarioIds } from "./see-it-fail.mjs";

const REPO = join(import.meta.dirname, "..");

function memory(files: Record<string, string>) {
  return {
    list: (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)),
    read: (path: string) => files[path] ?? null,
  };
}

const requirements = (status = "active", extra = "") => `# Accounts

## REQ-ACC-001 Sign up

- status: ${status}

A visitor can sign up.${extra}

## REQ-ACC-002 Handle

- status: active

A handle.
`;

const spec = `# Accounts

### IT-ACC-001 Sign up
- **Covers:** REQ-ACC-001
- **Runs:** push

### IT-ACC-002 Handle
- **Covers:** REQ-ACC-002
- **Phase:** orgs
`;

const world = (scenarios: Record<string, string>, req = requirements()) =>
  memory({ "docs/requirements/accounts.md": req, "docs/testing/accounts.md": spec, ...scenarios });

const good = `import { scenario, expect } from "@packserver/test-world";
scenario("IT-ACC-001 Sign up", async (world) => {
  const visitor = await world.visitor();
  expect(await visitor.signUp()).toBeSignedIn();
});
`;

describe("the repository", () => {
  it("passes its own scenario check", () => {
    const { problems } = checkTree(fsSource(REPO));
    expect(problems).toEqual([]);
  });

  it("keeps its signals catalogue and the monitoring doc in step", () => {
    const code = readFileSync(join(REPO, "packages/schema/src/shapes/signals.ts"), "utf8");
    const doc = readFileSync(join(REPO, "docs/operations/monitoring.md"), "utf8");
    expect(signalsInDoc(doc).length).toBeGreaterThan(80);
    expect(checkSignals(code, doc)).toEqual([]);
  });
});

describe("checkTree", () => {
  it("accepts a scenario named for a specified test", () => {
    const r = checkTree(world({ "scenarios/accounts.scenario.ts": good }));
    expect(r.problems).toEqual([]);
    expect(r.summary).toContain("1 of 1 v1 tests");
  });

  it("refuses a scenario that names an unspecified test", () => {
    const r = checkTree(world({ "scenarios/a.scenario.ts": good.replace("IT-ACC-001", "IT-ACC-099") }));
    expect(r.problems).toEqual(["scenarios/a.scenario.ts:2: IT-ACC-099 is not specified in docs/testing"]);
  });

  it("refuses a scenario whose test covers a retired requirement", () => {
    const r = checkTree(world({ "scenarios/a.scenario.ts": good }, requirements("retired")));
    expect(r.problems).toEqual(["scenarios/a.scenario.ts:2: IT-ACC-001 covers retired REQ-ACC-001"]);
  });

  it("refuses an unknown or retired requirement named in a title", () => {
    const r = checkTree(world({ "scenarios/a.scenario.ts": good.replace("Sign up\"", "Sign up REQ-ACC-777\"") }));
    expect(r.problems[0]).toContain("unknown REQ-ACC-777");
  });

  it("refuses a test id with two scenarios and a title that is not a literal", () => {
    const twice = good + good.replace("import", "// import").split("\n").slice(1).join("\n");
    expect(checkTree(world({ "scenarios/a.scenario.ts": twice })).problems[0]).toContain("already has a scenario");
    const dynamic = good.replace('"IT-ACC-001 Sign up"', "TITLE");
    expect(checkTree(world({ "scenarios/a.scenario.ts": dynamic })).problems[0]).toContain("plain string");
  });

  it("refuses endpoint vocabulary in a comment but not in a harness file", () => {
    const loud = `// POST /api/auth then 404\n${good}`;
    expect(checkTree(world({ "scenarios/a.scenario.ts": loud })).problems).toHaveLength(1);
    expect(checkTree(world({ "scenarios/_a.scenario.ts": loud })).problems).toEqual([]);
  });

  it("refuses a probe-safe scenario that touches the clock", () => {
    const probe = good.replace("  const visitor", "  await world.clock.advance('1h');\n  const visitor").replace("});\n", "}, { tags: ['probe-safe'] });\n");
    const r = checkTree(world({ "scenarios/a.scenario.ts": probe }));
    expect(r.problems).toEqual(["scenarios/a.scenario.ts:2: a probe-safe scenario uses world.clock"]);
    expect(checkTree(world({ "scenarios/a.scenario.ts": probe.replace("probe-safe", "other") })).problems).toEqual([]);
  });

  it("with --complete, wants a scenario for every v1 test", () => {
    expect(checkTree(world({}), { complete: true }).problems).toEqual(["IT-ACC-001 has no scenario (covers REQ-ACC-001, none excused)"]);
  });

  it("refuses a scenario that disappeared since the base", () => {
    const base = world({ "scenarios/a.scenario.ts": good });
    expect(checkTree(world({}), { baseSrc: base }).problems).toEqual(["IT-ACC-001 had a scenario on the base and has none now"]);
  });
});

describe("checkGate", () => {
  const base = world({ "scenarios/a.scenario.ts": good });
  const edited = good.replace("toBeSignedIn()", "toBeSignedInAs('visitor')");

  it("lets an unchanged or reformatted-comment-only scenario through only when text is the same", () => {
    expect(checkGate(base, base, "").problems).toEqual([]);
    expect(checkGate(base, world({ "scenarios/a.scenario.ts": `// note\n${good}` }), "").problems).toEqual([]);
  });

  it("refuses a changed scenario with no requirement change", () => {
    const r = checkGate(base, world({ "scenarios/a.scenario.ts": edited }), "");
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("IT-ACC-001");
  });

  it("accepts it when the requirement's own block changed", () => {
    const head = world({ "scenarios/a.scenario.ts": edited }, requirements("active", " Now with a passkey."));
    expect(checkGate(base, head, "").problems).toEqual([]);
  });

  it("does not count an edit to a different requirement", () => {
    const head = world({ "scenarios/a.scenario.ts": edited }, requirements().replace("A handle.", "A handle, changed."));
    expect(checkGate(base, head, "").problems).toHaveLength(1);
  });

  it("accepts a Requirement-Change line in the pull request body", () => {
    const head = world({ "scenarios/a.scenario.ts": edited });
    expect(checkGate(base, head, "Why\nRequirement-Change: REQ-ACC-001 split").problems).toEqual([]);
  });

  it("accepts a refactor only while the assertions stay the same", () => {
    const renamed = good.replace("visitor", "person").replace("visitor", "person");
    expect(checkGate(base, world({ "scenarios/a.scenario.ts": renamed }), "").problems).toHaveLength(1);
    expect(checkGate(base, world({ "scenarios/a.scenario.ts": renamed }), "Scenario-Refactor: rename a local").problems).toEqual([]);
    const weaker = checkGate(base, world({ "scenarios/a.scenario.ts": edited }), "Scenario-Refactor: tidy");
    expect(weaker.problems[0]).toContain("changed its assertions");
  });

  it("applies a declared matcher rename", () => {
    const head = world({ "scenarios/a.scenario.ts": good.replace("toBeSignedIn", "toBeAuthenticated") });
    expect(checkGate(base, head, "Scenario-Refactor: rename\nrename: toBeSignedIn -> toBeAuthenticated").problems).toEqual([]);
  });

  it("refuses removing a scenario, lets a new one in", () => {
    expect(checkGate(base, world({}), "").problems).toHaveLength(1);
    const added = checkGate(world({}), base, "");
    expect(added.problems).toEqual([]);
    expect(added.notes).toEqual(["new scenario IT-ACC-001"]);
  });
});

describe("scanScenarios", () => {
  it("ignores scenario( inside comments and strings", () => {
    const { scenarios } = scanScenarios("x", `// scenario("IT-ACC-001 a", () => {})\nconst s = 'scenario("IT-ACC-001 b", f)';`);
    expect(scenarios).toEqual([]);
  });
});

describe("check-signals", () => {
  it("reports a signal present on one side only", () => {
    const code = readFileSync(join(REPO, "packages/schema/src/shapes/signals.ts"), "utf8");
    const doc = readFileSync(join(REPO, "docs/operations/monitoring.md"), "utf8");
    expect(signalsInCode(code)).toContain("download.served");
    expect(checkSignals(code.replace('"served", "hash_mismatch", "hash_mismatch_reported"', '"served"'), doc).length).toBe(2);
    expect(checkSignals(code, doc.replace("`dlq`, ", ""))[0]).toContain("queue.dlq");
  });
});

describe("see-it-fail", () => {
  it("finds the scenarios a ref lacks and reads exemptions", () => {
    expect(newScenarioIds(world({}), world({ "scenarios/a.scenario.ts": good }))).toEqual(["IT-ACC-001"]);
    expect([...exemptIds("x\nScenario-Already-Green: IT-ACC-001 documents existing behaviour")]).toEqual(["IT-ACC-001"]);
  });

  it("counts an infrastructure error as neither red nor green", () => {
    expect(judge({ status: 1, output: "AssertionError" })).toBe("red");
    expect(judge({ status: 1, output: "InfrastructureError: no verb" })).toBe("infrastructure");
    expect(judge({ status: 0, output: "" })).toBe("green");
  });
});

describe("the scenario lint", () => {
  const eslint = new ESLint({ cwd: REPO });
  const lint = async (code: string, file = "scenarios/x.scenario.ts") => {
    const [r] = await eslint.lintText(code, { filePath: join(REPO, file) });
    return r!.messages.map((m) => m.message);
  };

  it("passes a plain scenario", async () => {
    expect(await lint(good)).toEqual([]);
  });

  it("forbids endpoint vocabulary, loose matchers, try and foreign imports", async () => {
    const messages = await lint(`import fs from "node:fs";
scenario("IT-ACC-001 x", async (world) => {
  try { await fetch("https://example.test/api/x"); } catch { /* 404 */ }
  expect(world.thing).toBeTruthy();
});`);
    expect(messages.length).toBeGreaterThanOrEqual(6);
  });

  it("forbids a probe-safe scenario from using the clock, and only that", async () => {
    const probe = (call: string, tag = "probe-safe") =>
      `scenario("IT-ACC-001 x", async (world) => { ${call} }, { tags: ["${tag}"] });`;
    expect(await lint(probe("await world.clock.advance('1h');"))).toEqual([expect.stringContaining("world.clock.advance")]);
    expect(await lint(probe("await world.clock.advance('1h');", "other"))).toEqual([]);
    expect(await lint(probe("await world.operator.deployedVersion();"))).toEqual([]);
  });

  it("leaves harness files alone", async () => {
    expect(await lint(`import { x } from "../packages/test-world/world/smoke";\nscenario.smoke(x.title, x.body);`, "scenarios/_smoke.scenario.ts")).toEqual([]);
  });
});

describe("the gate workflow", () => {
  const yml = readFileSync(join(REPO, ".github/workflows/scenario-gate.yml"), "utf8");

  it("runs from the base on pull_request_target as a job named scenario-gate", () => {
    expect(yml).toMatch(/^on:\n {2}pull_request_target:/m);
    expect(yml).toMatch(/^ {2}scenario-gate:\n/m);
    expect(yml).toContain("ref: ${{ github.event.pull_request.base.sha }}");
  });

  it("executes nothing from the head and keeps event data out of run: lines", () => {
    expect(yml).not.toMatch(/pnpm|npm |npx|setup-node/);
    for (const line of yml.split("\n").filter((l) => /^\s+run:/.test(l))) expect(line).not.toContain("${{");
    expect(yml).toContain('git fetch --no-tags origin "+refs/pull/${PR}/head:refs/pr/head"');
  });
});
