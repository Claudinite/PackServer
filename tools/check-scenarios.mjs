#!/usr/bin/env node
// The authority over scenarios/**: no scenario names an unknown or retired test or requirement,
// scenarios speak the World's vocabulary, probe-safe scenarios stay pure, and (with --gate) no
// scenario that existed on the base changes without a requirement change.
//
//   node tools/check-scenarios.mjs                       # check the working tree
//   node tools/check-scenarios.mjs --base <ref>          # also refuse a scenario that disappeared since <ref>
//   node tools/check-scenarios.mjs --complete            # also refuse a v1 test with no scenario yet
//   node tools/check-scenarios.mjs --gate --base <sha> --head <sha>   # CI gate; reads head as text only
//
// The gate reads the pull request body from $PR_BODY for the Requirement-Change and
// Scenario-Refactor declarations. It needs nothing installed and executes nothing from the head.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_UNSAFE, VOCABULARY } from "../eslint/scenarios.js";

const REQ = /REQ-[A-Z]+-\d{3}/g;
const TEST_ID = /^((?:IT-[A-Z]+|JT)-\d{3})\b/;
const SCENARIO_FILE = /^scenarios\/(?:.*\/)?[^/]+\.scenario\.ts$/;

// --- where files come from -------------------------------------------------------------------
export function fsSource(root) {
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "node_modules" ? [] : walk(posix.join(dir, e.name))) : [posix.join(dir, e.name)],
    );
  return {
    list: (dir) => {
      try {
        return walk(dir);
      } catch {
        return [];
      }
    },
    read: (path) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
  };
}

export function gitSource(root, ref) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  return {
    list: (dir) => {
      try {
        return git("ls-tree", "-r", "--name-only", ref, `${dir}/`).split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    read: (path) => {
      try {
        return git("show", `${ref}:${path}`);
      } catch {
        return null;
      }
    },
  };
}

// --- the register and the test specs -----------------------------------------------------------
export function loadRegister(src) {
  const requirements = new Map();
  const blocks = new Map();
  for (const path of src.list("docs/requirements").filter((p) => p.endsWith(".md") && !p.endsWith("/README.md"))) {
    let current = null;
    let text = "";
    const flush = () => current && blocks.set(current.id, text.trim());
    for (const line of src.read(path).split("\n")) {
      const h = /^## (REQ-[A-Z]+-\d{3}) (.*)$/.exec(line);
      if (h || /^## /.test(line)) {
        flush();
        current = h ? { id: h[1], title: h[2].trim(), status: null } : null;
        text = "";
        if (current) requirements.set(current.id, current);
        continue;
      }
      if (!current) continue;
      text += `${line}\n`;
      const s = /^- status: (\w+)/.exec(line);
      if (s) current.status = s[1];
    }
    flush();
  }
  return { requirements, blocks };
}

export function loadSpecs(src) {
  const tests = new Map();
  const excused = new Set();
  for (const path of src.list("docs/testing").filter((p) => p.endsWith(".md") && !/\/(README|coverage)\.md$/.test(p))) {
    let current = null;
    let inExcuses = false;
    for (const line of src.read(path).split("\n")) {
      const h = /^### ((?:IT-[A-Z]+|JT)-\d{3}) (.*)$/.exec(line);
      if (h) {
        current = { id: h[1], covers: [], phase: null };
        tests.set(current.id, current);
        inExcuses = false;
        continue;
      }
      if (/^## Not covered by an integration test/.test(line)) {
        inExcuses = true;
        current = null;
        continue;
      }
      if (/^## /.test(line)) {
        inExcuses = false;
        current = null;
      }
      if (inExcuses) {
        const e = /^- \*\*(REQ-[A-Z]+-\d{3})\*\* — (\w[\w-]*)/.exec(line);
        if (e && !e[2].startsWith("covered")) excused.add(e[1]);
        continue;
      }
      if (!current) continue;
      const c = /^- \*\*Covers:\*\* (.*)$/.exec(line);
      if (c) current.covers = c[1].match(REQ) ?? [];
      const p = /^- \*\*Phase:\*\* (.*)$/.exec(line);
      if (p) current.phase = p[1].trim();
    }
  }
  return { tests, excused };
}

// --- reading scenario source -------------------------------------------------------------------
/** Blanks comments and string contents while keeping every offset, so structure can be scanned safely. */
export function mask(source) {
  let code = "";
  let stripped = "";
  const comments = [];
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      comments.push({ text: source.slice(i + 2, stop), at: i });
      code += blank(source.slice(i, stop));
      stripped += " ";
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      comments.push({ text: source.slice(i + 2, stop - 2), at: i });
      code += blank(source.slice(i, stop));
      stripped += " ";
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      code += c + blank(source.slice(i + 1, j)) + (source[j] ?? "");
      stripped += source.slice(i, j + 1);
      i = j + 1;
    } else {
      code += c;
      stripped += c;
      i += 1;
    }
  }
  return { code, stripped, comments };
}

const lineOf = (source, at) => source.slice(0, at).split("\n").length;

function matching(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if ("([{".includes(code[i])) depth++;
    else if (")]}".includes(code[i]) && --depth === 0) return i;
  }
  return -1;
}

function splitArgs(code, open, close) {
  const args = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    if ("([{".includes(code[i])) depth++;
    else if (")]}".includes(code[i])) depth--;
    else if (code[i] === "," && depth === 0) {
      args.push([from, i]);
      from = i + 1;
    }
  }
  if (code.slice(from, close).trim()) args.push([from, close]);
  return args;
}

/** The statements that assert, with whitespace and comments gone: what a scenario proves. */
function expectStatements(maskedBody, body) {
  const out = new Set();
  const re = /\bexpect\b/g;
  let m;
  while ((m = re.exec(maskedBody))) {
    let depth = 0;
    let i = m.index;
    for (; i < maskedBody.length; i++) {
      if ("([{".includes(maskedBody[i])) depth++;
      else if (")]}".includes(maskedBody[i])) depth--;
      if (depth < 0 || (depth === 0 && maskedBody[i] === ";")) break;
    }
    out.add(squash(body.slice(m.index, i)));
    re.lastIndex = i;
  }
  return out;
}

/** Comments and whitespace removed: what a scenario says, whatever its layout. */
function squash(text) {
  return mask(text).stripped.replace(/\s+/g, "");
}

export function scanScenarios(path, source) {
  const { code, comments } = mask(source);
  const found = [];
  const re = /\bscenario(\.smoke)?\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = matching(code, open);
    if (close === -1) continue;
    const args = splitArgs(code, open, close);
    const first = args[0] ? source.slice(args[0][0], args[0][1]).trim() : "";
    const quote = first[0];
    const literal = `"'\``.includes(quote ?? "x") && first.endsWith(quote) && !first.includes("${");
    const title = literal ? first.slice(1, -1) : null;
    const body = args[1] ? source.slice(args[1][0], args[1][1]) : "";
    const maskedBody = args[1] ? code.slice(args[1][0], args[1][1]) : "";
    const opts = args[2] ? source.slice(args[2][0], args[2][1]) : "";
    found.push({
      path,
      line: lineOf(source, m.index),
      smoke: Boolean(m[1]),
      title,
      id: title ? TEST_ID.exec(title)?.[1] ?? null : null,
      probeSafe: /["'`]probe-safe["'`]/.test(opts),
      maskedBody,
      body,
      expects: expectStatements(maskedBody, body),
      normalised: squash(source.slice(open, close + 1)),
    });
  }
  return { scenarios: found, comments: comments.map((c) => ({ ...c, line: lineOf(source, c.at) })), code, source };
}

export function loadScenarios(src) {
  const files = src.list("scenarios").filter((p) => SCENARIO_FILE.test(p));
  return files.map((path) => ({ path, harness: posix.basename(path).startsWith("_"), ...scanScenarios(path, src.read(path)) }));
}

// --- the checks --------------------------------------------------------------------------------
export function checkTree(src, { baseSrc = null, complete = false } = {}) {
  const problems = [];
  const { requirements } = loadRegister(src);
  const { tests, excused } = loadSpecs(src);
  const files = loadScenarios(src);
  const scenarioIds = new Map();

  for (const f of files) {
    if (f.harness) continue;
    for (const c of f.comments) {
      const hit = VOCABULARY.find((v) => v.pattern.test(c.text));
      if (hit) problems.push(`${f.path}:${c.line}: ${hit.name} in a comment; say it in the World's vocabulary`);
    }
    for (const s of f.scenarios) {
      const where = `${s.path}:${s.line}`;
      if (s.smoke) continue;
      if (!s.title) {
        problems.push(`${where}: scenario title must be a plain string starting with a test id`);
        continue;
      }
      if (!s.id) {
        problems.push(`${where}: scenario "${s.title}" must start with a test id such as IT-ACC-001`);
        continue;
      }
      const spec = tests.get(s.id);
      if (!spec) {
        problems.push(`${where}: ${s.id} is not specified in docs/testing`);
        continue;
      }
      if (scenarioIds.has(s.id)) problems.push(`${where}: ${s.id} already has a scenario at ${scenarioIds.get(s.id)}`);
      scenarioIds.set(s.id, where);
      for (const req of spec.covers) {
        const r = requirements.get(req);
        if (!r) problems.push(`${where}: ${s.id} covers unknown ${req}`);
        else if (r.status === "retired") problems.push(`${where}: ${s.id} covers retired ${req}`);
      }
      for (const req of s.title.match(REQ) ?? []) {
        const r = requirements.get(req);
        if (!r || r.status === "retired") problems.push(`${where}: the title names ${r ? "retired" : "unknown"} ${req}`);
      }
      if (s.probeSafe) {
        for (const m of s.maskedBody.matchAll(/\bworld\s*\.\s*([A-Za-z_][\w.\s]*)/g)) {
          const path = m[1].replace(/\s+/g, "");
          const hit = PROBE_UNSAFE.find((p) => path === p || path.startsWith(`${p}.`));
          if (hit) problems.push(`${where}: a probe-safe scenario uses world.${hit}`);
        }
      }
    }
  }

  const v1 = [...tests.values()].filter((t) => !t.phase);
  const written = v1.filter((t) => scenarioIds.has(t.id));
  const unwritten = v1.filter((t) => !scenarioIds.has(t.id));
  if (complete) {
    for (const t of unwritten) {
      const unexcused = t.covers.filter((r) => requirements.get(r)?.status !== "retired" && !excused.has(r));
      if (unexcused.length) problems.push(`${t.id} has no scenario (covers ${unexcused.join(", ")}, none excused)`);
    }
  }
  if (baseSrc) {
    const before = new Set(loadScenarios(baseSrc).flatMap((f) => f.scenarios.map((s) => s.id).filter(Boolean)));
    for (const id of before) {
      if (!scenarioIds.has(id) && tests.has(id)) problems.push(`${id} had a scenario on the base and has none now`);
    }
  }
  return { problems, summary: `scenarios: ${written.length} of ${v1.length} v1 tests have a scenario (${unwritten.length} to write)` };
}

// --- the gate ----------------------------------------------------------------------------------
function declared(body, name) {
  return [...(body ?? "").matchAll(new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "gim"))].map((m) => m[1].trim());
}

function renamesIn(body) {
  return [...(body ?? "").matchAll(/^\s*rename:[ \t]*(\S+)[ \t]*->[ \t]*(\S+)/gim)].map((m) => [m[1], m[2]]);
}

export function checkGate(baseSrc, headSrc, prBody) {
  const problems = [];
  const notes = [];
  const baseReg = loadRegister(baseSrc);
  const headReg = loadRegister(headSrc);
  const baseSpecs = loadSpecs(baseSrc);
  const headSpecs = loadSpecs(headSrc);
  const byId = (files) => new Map(files.filter((f) => !f.harness).flatMap((f) => f.scenarios.filter((s) => s.id).map((s) => [s.id, s])));
  const before = byId(loadScenarios(baseSrc));
  const after = byId(loadScenarios(headSrc));

  const trailerReqs = new Set(declared(prBody, "Requirement-Change").flatMap((l) => l.match(REQ) ?? []));
  const refactor = declared(prBody, "Scenario-Refactor").some(Boolean);
  const renames = renamesIn(prBody);
  const changedBlocks = new Set(
    [...new Set([...baseReg.blocks.keys(), ...headReg.blocks.keys()])].filter((id) => baseReg.blocks.get(id) !== headReg.blocks.get(id)),
  );
  const evidenceFor = (reqs) => reqs.find((r) => changedBlocks.has(r) || trailerReqs.has(r));

  for (const [id, old] of before) {
    const now = after.get(id);
    const covers = (headSpecs.tests.get(id) ?? baseSpecs.tests.get(id))?.covers ?? [];
    if (now && now.normalised === old.normalised) continue;
    const label = `${old.path}:${old.line} ${id}`;
    if (evidenceFor(covers)) continue;
    if (!now) {
      problems.push(`${label} was removed, and none of ${covers.join(", ") || "its requirements"} changed in docs/requirements or in a Requirement-Change line of the pull request body`);
      continue;
    }
    if (refactor && changedBlocks.size === 0) {
      const sameAssertions = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
      const renamed = new Set([...old.expects].map((e) => renames.reduce((t, [from, to]) => t.split(from).join(to), e)));
      if (sameAssertions(renamed, new Set(now.expects))) continue;
      problems.push(
        `${label} changed its assertions under Scenario-Refactor\n    before: ${[...old.expects].join(" | ")}\n    after:  ${[...now.expects].join(" | ")}`,
      );
      continue;
    }
    problems.push(`${label} changed, and none of ${covers.join(", ") || "its requirements"} changed in docs/requirements or in a Requirement-Change line of the pull request body (a mechanical change declares Scenario-Refactor: <reason>)`);
  }
  for (const id of after.keys()) if (!before.has(id)) notes.push(`new scenario ${id}`);
  return { problems, notes };
}

// --- command line --------------------------------------------------------------------------------
function main(argv) {
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const root = arg("--root") ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  let problems;
  let lines;
  if (argv.includes("--gate")) {
    const base = arg("--base");
    const head = arg("--head");
    if (!base || !head) throw new Error("--gate needs --base and --head");
    const headSrc = gitSource(root, head);
    const baseSrc = gitSource(root, base);
    const tree = checkTree(headSrc, { baseSrc: null });
    const gate = checkGate(baseSrc, headSrc, process.env.PR_BODY ?? "");
    problems = [...tree.problems, ...gate.problems];
    const touched = execFileSync("git", ["-C", root, "diff", "--name-only", `${base}...${head}`], { encoding: "utf8" })
      .split("\n")
      .filter((f) => /^(\.github\/workflows\/scenario-gate\.yml|tools\/check-scenarios\.mjs|eslint\/scenarios\.js)$/.test(f));
    lines = [tree.summary, ...gate.notes, ...touched.map((f) => `note: this change edits the gate itself (${f}); the gate that judged it is the base copy`)];
  } else {
    const base = arg("--base");
    const tree = checkTree(fsSource(root), { baseSrc: base ? gitSource(root, base) : null, complete: argv.includes("--complete") });
    problems = tree.problems;
    lines = [tree.summary];
  }
  for (const l of lines) console.log(l);
  for (const p of problems) console.error(`problem: ${p}`);
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
