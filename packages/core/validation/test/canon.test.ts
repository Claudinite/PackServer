import { describe, expect, it } from "vitest";
import { inspector } from "@packserver/core/capabilities";
import { checkCode, extractCapabilities, readManifest, runStaticRules } from "../index.ts";
import { CANON_PACKS, canonPack } from "./canon.ts";
import { cleanFiles, fakePorts, input, make, treeOf } from "./helpers.ts";
import { TASK_JSON } from "./pack-fixtures.ts";

type Files = Record<string, string | Uint8Array>;

function analyse(files: Files) {
  const tree = treeOf(files);
  const read = readManifest(tree, make);
  const manifest = read.ok ? read.manifest : null;
  const extraction = extractCapabilities(tree, manifest);
  return { extraction, findings: checkCode(tree, make, manifest, extraction) };
}
const rules = (files: Files) => [...new Set(analyse(files).findings.map((f) => f.rule))].sort();
const task = (worker: string, name = "worker.mjs", json = TASK_JSON()) => ({ ...cleanFiles(), "tasks/t/task.json": json, [`tasks/t/${name}`]: worker });
const sh = (body: string) => ({ ...cleanFiles(), "env/setup.sh": `${body}\n` });

describe("the vendored canon packs are the authority for file formats", () => {
  const expected: Record<string, { guards: number; forced: string[]; tasks: { name: string; opens_pr: boolean; agentic_phase: boolean }[] }> = {
    basics: {
      guards: 10,
      forced: ["authoring-agent-docs", "committing", "fetching-from-the-web", "searching-for-a-tool", "working-with-generated-files", "writing-handover-issues", "writing-repo-scanning-checks", "writing-tests"],
      tasks: [],
    },
    "git-github": { guards: 5, forced: ["merge-to-main"], tasks: [] },
    node: { guards: 0, forced: ["node-test-discovery"], tasks: [] },
    "public-website": { guards: 0, forced: [], tasks: [] },
    html: { guards: 0, forced: [], tasks: [] },
    jwt: { guards: 0, forced: [], tasks: [] },
    "cloudflare-workers": { guards: 0, forced: [], tasks: [] },
  };
  it("covers every canon pack that was copied in", () => {
    expect([...CANON_PACKS].sort()).toEqual(Object.keys(expected).sort());
  });
  for (const name of CANON_PACKS) {
    it(`${name}: pins guards, forced skills and tasks`, () => {
      const { extraction } = analyse(canonPack(name));
      const want = expected[name]!;
      expect(extraction.preinstall.guards).toHaveLength(want.guards);
      expect([...extraction.preinstall.forced_skills].sort()).toEqual(want.forced);
      if (name === "basics") {
        const tasks = extraction.preinstall.tasks;
        expect(tasks.length).toBeGreaterThan(0);
        for (const t of tasks) expect(t.cadence).toBe("at-most-weekly");
        expect(tasks.find((t) => t.name === "ci-performance")).toMatchObject({ opens_pr: true, agentic_phase: true });
        expect(extraction.capabilities).toContain("task:opens-pr");
        expect(extraction.capabilities).toContain("task:agentic-phase");
      }
    });
    it(`${name}: never trips the foreign-import or undeclared-action rule`, () => {
      const hit = analyse(canonPack(name)).findings.filter((f) => f.rule === "code.foreign-import" || f.rule === "code.undeclared-action" || f.rule === "code.binary-file");
      expect(hit).toEqual([]);
    });
  }
  it("records what the scanner really finds in the canon task workers", () => {
    // Known: the canon's own ci-performance worker defaults a parameter to the bare global fetch and
    // reads the clock three times; the scanner reports them as it would for any pack.
    const found = analyse(canonPack("basics")).findings.map((f) => `${f.rule} ${f.file}`);
    expect(found.filter((x) => x.startsWith("code.network"))).toEqual(["code.network tasks/ci-performance/github-api.mjs"]);
    expect(found.filter((x) => x.startsWith("code.time-conditional"))).toEqual(Array(3).fill("code.time-conditional tasks/ci-performance/worker.mjs"));
    expect(found.filter((x) => !/^code\.(network|time-conditional) /.test(x))).toEqual([]);
  });
});

describe("task flags in the canon's own vocabulary", () => {
  const flags = (obj: Record<string, unknown>) => analyse({ ...cleanFiles(), "tasks/t/task.json": JSON.stringify({ id: "t", trigger: "schedule", preconditions: ["schedule:at-most-monthly"], ...obj }) }).extraction.preinstall.tasks[0]!;
  it("reads cadence from the schedule precondition", () => {
    expect(flags({}).cadence).toBe("at-most-monthly");
  });
  it("expected_outcome fresh_pr opens a PR; agent_instructions and agent_model make an agentic phase", () => {
    expect(flags({ expected_outcome: "fresh_pr" })).toMatchObject({ opens_pr: true, agentic_phase: false });
    expect(flags({ agent_instructions: "task.md" })).toMatchObject({ opens_pr: false, agentic_phase: true });
    expect(flags({ agent_model: "sonnet" })).toMatchObject({ agentic_phase: true });
    expect(flags({})).toMatchObject({ opens_pr: false, agentic_phase: false });
  });
  it("fails closed: an unknown key about prs, agents or prompts claims both flags", () => {
    for (const key of ["pr_strategy", "agent_prompt", "agent", "outcome_hint", "instructions_file"]) expect(flags({ [key]: "x" }), key).toMatchObject({ opens_pr: true, agentic_phase: true });
  });
});

describe("forced skills in the canon's frontmatter", () => {
  const forced = (fm: string) => analyse({ ...cleanFiles(), "skills/s/SKILL.md": `---\nname: s\n${fm}\n---\nbody\n` }).extraction.preinstall.forced_skills.length;
  it("counts force-load keys under metadata at any indentation, with a list value", () => {
    expect(forced('metadata:\n  force-load-on-tool-calls:\n    - "Bash"\n')).toBe(1);
    expect(forced('metadata:\n  usage:\n    nested:\n      force-load-on-file-edits-paths:\n        - "x/**"\n')).toBe(1);
    expect(forced('force_load_on_tool_results_matching: "x"\n')).toBe(1);
    expect(forced("metadata:\n  forced: true\n")).toBe(1);
  });
  it("ignores enforced, a false value and plain metadata", () => {
    expect(forced("metadata:\n  enforced: true\n")).toBe(0);
    expect(forced("metadata:\n  forced: false\n")).toBe(0);
    expect(forced("metadata:\n  body: workflow\n  usage:\n    expect: judgment\n")).toBe(0);
  });
});

describe("guards fail closed", () => {
  it("a declared check with any guard key judges every tool when it cannot be read", () => {
    const g = analyse({ ...cleanFiles(), "declared-checks.json": JSON.stringify([{ id: "a/g", guardToolCalls: "bogus" }]) }).extraction.preinstall.guards;
    expect(g).toEqual([{ name: "a/g", tool_calls: ["*"] }]);
  });
  it("a guard in skills/*/declared-checks.json counts", () => {
    const g = analyse({ ...cleanFiles(), "skills/s/declared-checks.json": JSON.stringify([{ id: "s/g", guardToolCalls: [{ tool: "Bash", inputMatches: "/x/" }] }]) }).extraction.preinstall.guards;
    expect(g).toEqual([{ name: "s/g", tool_calls: ["Bash"] }]);
  });
  it("a Go check aliased on the SDK with a hook tag is a guard, a plain one is not", () => {
    const go = (tags: string) => ({ ...cleanFiles(), "checks/c.go": `package checks\nimport sdk "claudinite.com/checksdk"\nfunc init() { sdk.Register(sdk.Check{ID: "c", Tags: []string{${tags}}}) }\n` });
    expect(analyse(go('"PreToolUse:Bash"')).extraction.preinstall.guards).toHaveLength(1);
    expect(analyse(go('"world"')).extraction.preinstall.guards).toHaveLength(0);
    expect(rules(go('"world"'))).toEqual([]);
  });
});

describe("evasions of the network and eval rules", () => {
  it("JS: computed access on the global object, an alias, or a built name", () => {
    for (const body of [
      'globalThis["fe"+"tch"]("x");',
      "window[`fet${'ch'}`]('x');",
      'const g = globalThis; g["fetch"]("x");',
      'self[["fe","tch"].join("")]("x");',
      'globalThis[String.fromCharCode(102,101,116,99,104)]("x");',
      'globalThis["ev".concat("al")]("1");',
      '(0, globalThis["Function"])("return 1")();',
      "(()=>{}).constructor('return fetch')()();",
    ]) {
      expect(rules(task(`${body}\n`)), body).toEqual(expect.arrayContaining([expect.stringMatching(/^code\.(network|eval)$/)]));
    }
  });
  it("JS: a computed name that cannot be folded is held", () => {
    expect(rules(task("globalThis[process.env.X]('x');\n"))).toContain("code.dynamic-access");
    expect(rules(task("const { fetch: f } = globalThis; f('x');\n"))).toContain("code.network");
  });
  it("JS: relative imports of a sibling are fine, a missing or outside one is not", () => {
    const ok = { ...task('import { a } from "./lib.mjs";\n'), "tasks/t/lib.mjs": "export const a = 1;\n" };
    expect(rules(ok)).toEqual([]);
    expect(rules(task('import { a } from "./gone.mjs";\n'))).toContain("code.foreign-import");
    expect(rules(task('import { a } from "../other/x.mjs";\n'))).toContain("code.foreign-import");
  });
  it("Go: running a program is a failure", () => {
    for (const body of ['import "os/exec"\nvar _ = exec.Command("ls")', 'import "os"\nvar _, _ = os.StartProcess("/bin/sh", nil, nil)']) {
      expect(rules({ ...cleanFiles(), "checks/c.go": `package checks\n${body}\n` }), body).toContain("code.eval");
    }
  });
  it("shell: the command word is normalised before it is judged", () => {
    for (const body of ["/usr/bin/curl x", "'curl' x", '"cu"rl x', "\\curl x", "c''url x", "FOO=1 /bin/wget x", "env -i curl x", "command curl x"]) {
      expect(rules(sh(body)), body).toContain("code.network");
    }
  });
  it("shell: a variable as the command word is held; interpreter one-liners are eval", () => {
    expect(rules(sh("$CMD x"))).toContain("code.dynamic-access");
    for (const body of ["python -c \"$X\"", "python3 -c 'import os'", "node -e 'x'", "perl -e 'x'", 'bash -c "$X"', 'sh -c "$X"', "eval \"$X\""]) {
      expect(rules(sh(body)), body).toContain("code.eval");
    }
  });
  it("shell: a literal bash -c argument is analysed in turn", () => {
    expect(rules(sh("bash -c 'curl x'"))).toContain("code.network");
    expect(rules(sh("bash -c 'echo hi'"))).toEqual([]);
  });
});

describe("what is executable and what is binary", () => {
  it("scans tasks/ files of any extension, a shebang script and checks/*.js", () => {
    expect(rules(task('import x from "lodash";\n', "worker.js2"))).toContain("code.foreign-import");
    expect(rules(task('import x from "lodash";\n', "helper"))).toContain("code.foreign-import");
    expect(rules(task("#!/bin/sh\ncurl x\n", "run"))).toContain("code.network");
    expect(rules({ ...cleanFiles(), "checks/x.js": 'import x from "lodash";\n' })).toContain("code.foreign-import");
  });
  it("scans a worker declared in task.json under an odd extension", () => {
    const files = { ...cleanFiles(), "tasks/t/task.json": JSON.stringify({ id: "t", trigger: "schedule", code_worker_mjs: "w.txt" }), "tasks/t/w.txt": 'import x from "lodash";\n' };
    expect(rules(files)).toContain("code.foreign-import");
  });
  it("fails a NUL-byte file at a non-text path, and a UTF-16 byte-order mark that is not UTF-16", () => {
    expect(rules({ ...cleanFiles(), "a.dat": new Uint8Array([1, 0, 2]) })).toContain("code.binary-file");
    expect(rules({ ...cleanFiles(), "a.txt": new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]) })).toContain("code.binary-file");
    expect(rules({ ...cleanFiles(), "a.txt": new Uint8Array([0xff, 0xfe, 0x41]) })).toContain("code.binary-file");
    expect(rules({ ...cleanFiles(), "a.txt": new Uint8Array([0xfe, 0xff, 0x00, 0x01, 0x00, 0x02]) })).toContain("code.binary-file");
  });
  it("accepts a real UTF-16 text file with a byte-order mark", () => {
    const le = Uint8Array.from([0xff, 0xfe, ...[...("hello\n")].flatMap((c) => [c.charCodeAt(0), 0])]);
    const be = Uint8Array.from([0xfe, 0xff, ...[...("hello\n")].flatMap((c) => [0, c.charCodeAt(0)])]);
    expect(rules({ ...cleanFiles(), "a.txt": le })).not.toContain("code.binary-file");
    expect(rules({ ...cleanFiles(), "a.txt": be })).not.toContain("code.binary-file");
  });
});

describe("the capability inspector sandbox A imports", () => {
  it("runs manifest, extraction, code rules and the pre-install manifest in one call", async () => {
    const tree = treeOf(canonPack("git-github"));
    const first = await inspector.inspect({ tree, pack: "@claudinite/git-github" });
    expect(first.capabilities?.preinstall.guards).toHaveLength(5);
    expect(first.capabilities?.capabilities).toContain("guard");
  });
  it("accepts the previous capability set, or the previous capabilities with their pre-install manifest", async () => {
    const tree = treeOf(canonPack("git-github"));
    const first = await inspector.inspect({ tree, pack: "p" });
    const prev = first.capabilities!;
    const same = await inspector.inspect({ tree, pack: "p", previousCapabilities: prev });
    expect(same.capabilities?.widening).toBe(false);
    expect(same.capabilities?.preinstall.new).toEqual([]);
    const fromSet = await inspector.inspect({ tree, pack: "p", previousCapabilities: prev.capabilities });
    expect(fromSet.capabilities?.widening).toBe(false);
    const grown = await inspector.inspect({ tree: treeOf({ ...canonPack("git-github"), "declared-checks.json": JSON.stringify([{ id: "n/g", guardToolCalls: [{ tool: "Bash", inputMatches: "/x/" }] }]) }), pack: "p", previousCapabilities: { capabilities: [], preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] } } });
    expect(grown.capabilities?.widening).toBe(true);
    expect(grown.capabilities?.preinstall.new.length).toBeGreaterThan(0);
  });
});

describe("hostile 5 MiB inputs that once went quadratic", () => {
  const MIB = 1024 * 1024;
  const repeatTo = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const cases: Record<string, Files> = {
    'JS "/[" repeated': { "tasks/t/w.mjs": repeatTo('"/[', 5 * MIB) },
    "JS /[ repeated": { "tasks/t/w.mjs": repeatTo("/[", 5 * MIB) },
    "JS folded names": { "tasks/t/w.mjs": repeatTo("globalThis['a'+'b'+`c`]; ", 5 * MIB) },
    "JS brackets": { "tasks/t/w.mjs": repeatTo("[", 5 * MIB) },
    "shell dynamic words": { "env/setup.sh": repeatTo("$X ", 5 * MIB) },
    "shell nested bash -c": { "env/setup.sh": repeatTo("bash -c '", 5 * MIB) },
    "shell continuation lines": { "env/setup.sh": repeatTo("a \\\n", 5 * MIB) },
    "UTF-16 mark with a long body": { "a.txt": Uint8Array.from([0xff, 0xfe, ...new Uint8Array(5 * MIB).fill(0x41)]) },
  };
  for (const [name, files] of Object.entries(cases)) {
    it(name, async () => {
      const t = Date.now();
      await runStaticRules(input({ ...cleanFiles(), ...(files as Record<string, string>) }), fakePorts());
      expect(Date.now() - t).toBeLessThan(15_000);
    }, 60_000);
  }
});
