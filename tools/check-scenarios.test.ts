import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { checkGate, checkTree, fsSource, gitSource, scanScenarios } from "./check-scenarios.mjs";
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

  it("refuses a rename that is not one identifier to another", () => {
    const head = world({ "scenarios/a.scenario.ts": good.replace("toBeSignedIn()", "toBeAnything(1)") });
    for (const line of ["rename: expect(await visitor.signUp()).toBeSignedIn() -> expect(1).toEqual(1)", 'rename: "ada" -> expect.any(String)', "rename: expect -> expect(1)"]) {
      const r = checkGate(base, head, `Scenario-Refactor: x\n${line}`);
      expect(r.problems.some((p) => p.includes("is refused"))).toBe(true);
    }
  });

  it("applies a rename on whole identifiers only", () => {
    const head = world({ "scenarios/a.scenario.ts": good.replaceAll("visitor", "person").replace("signUp", "signUpNow") });
    expect(checkGate(base, head, "Scenario-Refactor: x\nrename: sign -> hacked").problems).not.toEqual([]);
    expect(checkGate(base, head, "Scenario-Refactor: x\nrename: visitor -> person\nrename: signUp -> signUpNow").problems).toEqual([]);
  });

  it("gates code outside the scenario calls", () => {
    const withConst = (v: string) => `const WANT = "${v}";\n${good.replace("toBeSignedIn()", "toBeSignedInAs(WANT)")}`;
    const b = world({ "scenarios/a.scenario.ts": withConst("member") });
    const h = world({ "scenarios/a.scenario.ts": withConst("visitor") });
    expect(checkGate(b, h, "").problems).toHaveLength(1);
    expect(checkGate(b, h, "Scenario-Refactor: tidy").problems[0]).toContain("code around it");
    expect(checkGate(b, h, "Requirement-Change: REQ-ACC-001 new rule").problems).toEqual([]);
  });

  it("lets a name be added to the World import without touching the scenarios", () => {
    const head = world({ "scenarios/a.scenario.ts": good.replace("{ scenario, expect }", "{ scenario, expect, extra }") });
    expect(checkGate(base, head, "").problems).toEqual([]);
  });

  it("prints each scenario let through by a trailer", () => {
    const head = world({ "scenarios/a.scenario.ts": edited });
    expect(checkGate(base, head, "Requirement-Change: REQ-ACC-001 x").notes[0]).toContain("IT-ACC-001 admitted by the Requirement-Change");
    expect(checkGate(base, head, "Scenario-Refactor: x").notes).toEqual([]);
  });

  it("judges a changed scenario against the base's Covers", () => {
    const head = memory({
      "docs/requirements/accounts.md": requirements(),
      "docs/testing/accounts.md": spec.replace("Covers:** REQ-ACC-001", "Covers:** REQ-ACC-002"),
      "scenarios/a.scenario.ts": edited,
    });
    const changed = memory({ ...Object.fromEntries(["docs/testing/accounts.md", "scenarios/a.scenario.ts"].map((k) => [k, head.read(k)!])), "docs/requirements/accounts.md": requirements().replace("A handle.", "A handle, changed.") });
    expect(checkGate(base, changed, "").problems).toHaveLength(1);
  });

  it("refuses removing a scenario, lets a new one in", () => {
    expect(checkGate(base, world({}), "").problems).toHaveLength(1);
    const added = checkGate(world({}), base, "");
    expect(added.problems).toEqual([]);
    expect(added.notes).toEqual(["new scenario IT-ACC-001"]);
  });
});

describe("harness files", () => {
  it("are exempt only at the top of scenarios/, as the lint is", () => {
    const loud = `// POST /api/auth\n${good}`;
    expect(checkTree(world({ "scenarios/_a.scenario.ts": loud })).problems).toEqual([]);
    expect(checkTree(world({ "scenarios/sub/_a.scenario.ts": loud })).problems).toHaveLength(1);
  });
});

describe("linear time", () => {
  const within = (ms: number, f: () => void) => {
    const t = Date.now();
    f();
    expect(Date.now() - t).toBeLessThan(ms);
  };

  it("scans 40k comment lines", () => {
    within(2000, () => scanScenarios("x", "// a\n".repeat(40_000) + good));
  });

  it("scans 20k unclosed scenario( calls", () => {
    within(2000, () => scanScenarios("x", 'scenario("IT-ACC-001 x", ('.repeat(20_000)));
  });

  it("reads a pull request body of 65k blank lines", () => {
    const body = "\n".repeat(65_000);
    within(2000, () => checkGate(memory({}), memory({}), `${body}Requirement-Change: REQ-ACC-001\n${body}rename: a -> b`));
  });

  it("numbers lines correctly", () => {
    expect(scanScenarios("x", `\n\n${good}`).scenarios[0]!.line).toBe(4);
  });
});

describe("gitSource", () => {
  const dirs: string[] = [];
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "gitsrc-"));
    dirs.push(dir);
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
    git("init", "-q");
    mkdirSync(join(dir, "scenarios"));
    writeFileSync(join(dir, "scenarios/é.scenario.ts"), good);
    git("add", "-A");
    git("commit", "-qm", "x");
    return dir;
  };

  it("lists non-ASCII paths unquoted", () => {
    const dir = repo();
    expect(gitSource(dir, "HEAD").list("scenarios")).toEqual(["scenarios/é.scenario.ts"]);
    expect(gitSource(dir, "HEAD").read("scenarios/é.scenario.ts")).toBe(good);
    expect(gitSource(dir, "HEAD").read("scenarios/none.ts")).toBeNull();
    expect(gitSource(dir, "HEAD").list("nowhere")).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on a ref or repository git cannot read", () => {
    const dir = repo();
    expect(() => gitSource(dir, "no-such-ref")).toThrow();
    expect(() => gitSource(join(dir, "missing"), "HEAD")).toThrow();
    rmSync(dir, { recursive: true, force: true });
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
  });

  it("fetches the head with the read-only token handed through env, for that command only", () => {
    const step = yml.split("- name: fetch the head as data")[1]!.split("- name:")[0]!;
    expect(step).toContain("TOKEN: ${{ github.token }}");
    expect(step).toContain("::add-mask::$auth");
    expect(step).toMatch(/git -c "http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic \$auth" fetch --no-tags origin "\+refs\/pull\/\$\{PR\}\/head:refs\/pr\/head"/);
    expect(yml.match(/github\.token/g)).toHaveLength(1);
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n/m);
  });
});
