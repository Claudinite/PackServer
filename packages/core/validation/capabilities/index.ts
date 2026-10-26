import type { Capability, CapabilitySet, PreInstallManifest } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { decodeText } from "../engine/files.ts";
import { rawDoc } from "../text/doc.ts";
import { goChecks, hookTag } from "../code/analyze.ts";
import { goLexOf } from "../code/lexcache.ts";
import type { PackManifest } from "../manifest/index.ts";
import { executableKind, isEnvSetupPath } from "./paths.ts";
import { parseFrontmatter, isFalsyScalar } from "./frontmatter.ts";

export { executableKind, isEnvSetupPath } from "./paths.ts";
export { isWidening, newEntries, WIDENING } from "./widening.ts";

export type PreInstallBody = Omit<PreInstallManifest, "new">;

export interface Extraction {
  capabilities: CapabilitySet;
  preinstall: PreInstallBody;
  /** Normalised names of every GitHub action the archive uses, declared or not. */
  usedActions: { name: string; file: string; line: number | null }[];
  declaredActions: string[];
}

/** `owner/repo` names are case-insensitive on GitHub; a bare name, such as an engine action, is kept as written. */
export const normaliseAction = (name: string): string => {
  const base = name.trim().split("@")[0]!.replace(/\/+$/, "");
  return base.includes("/") ? base.toLowerCase() : base;
};

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && !(typeof v === "string" && isFalsyScalar(v));

function readJson(tree: Tree, path: string): { ok: boolean; value: unknown } | null {
  const f = tree.files.find((x) => x.path === path);
  if (!f) return null;
  const d = decodeText(f);
  if (!d) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(d.text.replace(/^\ufeff/, "")) };
  } catch {
    return { ok: false, value: null };
  }
}

function scheduleOf(task: Record<string, unknown>): string {
  const pre = task.preconditions;
  if (Array.isArray(pre)) {
    for (const p of pre) {
      const m = typeof p === "string" ? /^schedule:\s*(\S+)/.exec(p) : null;
      if (m) return m[1]!;
    }
  }
  const trigger = task.trigger;
  const t = asObject(trigger);
  for (const key of ["schedule", "cron", "cadence"]) {
    const v = t?.[key] ?? task[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (typeof trigger === "string" && trigger.trim()) return trigger.trim();
  return "manual";
}

const words = (key: string): string[] => key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const KNOWN_TASK_KEYS = new Set(["id", "name", "title", "description", "summary", "trigger", "preconditions", "automerge", "expected_outcome", "code_worker_mjs", "code_work_timeout", "worker", "pr", "opensPr", "opens_pr", "pullRequest"]);
const CLAIMING_WORDS = new Set(["pr", "pull", "prompt", "prompts", "instructions", "agent", "agentic", "outcome", "model"]);
const KNOWN_AGENT_KEYS = new Set(["agent_model", "agent_instructions", "agent_execution_timeout"]);
const PR_WORDS = new Set(["pr", "pull"]);

interface TaskFacts {
  name: string;
  cadence: string;
  opens_pr: boolean;
  agentic_phase: boolean;
}

/** A recognised key sets its flag; a key this reader does not know that talks about PRs or agents claims both, so a new spelling never undercounts. */
function taskFacts(name: string, json: { ok: boolean; value: unknown } | null): TaskFacts {
  const task = json?.ok ? asObject(json.value) : null;
  // A task.json that cannot be read claims everything, so the widening check never undercounts it.
  if (!task) return { name, cadence: "manual", opens_pr: true, agentic_phase: true };
  let opens = ["pr", "opensPr", "opens_pr", "pullRequest"].some((k) => truthy(task[k]));
  const outcome = task.expected_outcome;
  if (typeof outcome === "string" && words(outcome).some((w) => PR_WORDS.has(w))) opens = true;
  let agentic = false;
  let unknown = false;
  for (const [key, value] of Object.entries(task)) {
    const w = words(key);
    if (KNOWN_AGENT_KEYS.has(key)) {
      if (truthy(value)) agentic = true;
    } else if (!KNOWN_TASK_KEYS.has(key) && w.some((x) => CLAIMING_WORDS.has(x)) && truthy(value)) unknown = true;
  }
  return { name, cadence: scheduleOf(task), opens_pr: opens || unknown, agentic_phase: agentic || unknown };
}

function* strings(value: unknown, depth = 0): Generator<[string, string]> {
  if (depth > 20) return;
  if (Array.isArray(value)) for (const v of value) yield* strings(v, depth + 1);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") yield [k, v];
      else yield* strings(v, depth + 1);
    }
  }
}

const YAML_USES = /^[ \t-]*["']?uses["']?[ \t]*:[ \t]*["']?([^\s"'#]+)/gm;

function usedActionsOf(tree: Tree): Extraction["usedActions"] {
  const out: Extraction["usedActions"] = [];
  const add = (spec: string, file: string, line: number | null) => {
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("${{")) return;
    out.push({ name: normaliseAction(spec), file, line });
  };
  for (const f of tree.files) {
    const isYaml = /\.ya?ml$/i.test(f.path);
    const isTask = /^tasks\/[^/]+\/task\.json$/.test(f.path);
    if (!isYaml && !isTask) continue;
    const d = decodeText(f);
    if (!d) continue;
    if (isYaml) {
      const doc = rawDoc(f.path, d.text);
      for (const m of d.text.matchAll(YAML_USES)) add(m[1]!, f.path, doc.lineAt(m.index));
    } else {
      try {
        for (const [k, v] of strings(JSON.parse(d.text.replace(/^\ufeff/, "")))) if (k === "uses") add(v, f.path, null);
      } catch {
        // an unparseable task.json is the sandbox's finding
      }
    }
  }
  return out;
}

function forcedSkillsOf(tree: Tree, manifest: PackManifest | null): string[] {
  const forced = new Set<string>();
  const listed = manifest?.forcedSkills;
  if (Array.isArray(listed)) for (const s of listed) if (typeof s === "string" && s) forced.add(s);
  for (const f of tree.files) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(f.path);
    if (!m) continue;
    const d = decodeText(f);
    if (d && parseFrontmatter(d.text).forced) forced.add(m[1]!);
  }
  return [...forced].sort();
}

function declaredGuards(tree: Tree, add: (name: string, tools: string[]) => void): void {
  for (const f of tree.files) {
    if (!/^(?:skills\/[^/]+\/)?declared-checks\.json$/.test(f.path)) continue;
    const d = decodeText(f);
    if (!d) continue;
    let list: unknown;
    try {
      list = JSON.parse(d.text.replace(/^\ufeff/, ""));
    } catch {
      // A file that cannot be read still names guards if it says so; fail closed.
      if (/guard\w*|hook/i.test(d.text)) add(`${f.path}#unreadable`, ["*"]);
      continue;
    }
    const entries = Array.isArray(list) ? list : (asObject(list)?.checks as unknown);
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      const o = asObject(entry);
      if (!o) return;
      const guardKeys = Object.keys(o).filter((k) => /^guard/i.test(k));
      const event = o.event ?? o.hook;
      const hooked = typeof event === "string" ? hookTag(event) : event !== undefined && event !== null && event !== false;
      if (guardKeys.length === 0 && !hooked) return;
      const name = typeof o.id === "string" && o.id ? o.id : `${f.path}#${i}`;
      const calls = o.guardToolCalls;
      const tools: string[] = [];
      let readable = Array.isArray(calls) && calls.length > 0 && guardKeys.length === 1;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const tool = typeof c === "string" ? c : asObject(c)?.tool;
          if (typeof tool === "string" && tool) tools.push(tool);
          else readable = false;
        }
      }
      if (typeof event === "string" && hooked && typeof hooked === "object") tools.push(...hooked.tools.filter((t) => t !== "*"));
      add(name, readable || tools.length ? (readable ? tools : [...tools, "*"]) : ["*"]);
    });
  }
}

function guardsAndChecks(tree: Tree): { guards: PreInstallBody["guards"]; codedChecks: boolean } {
  const guards = new Map<string, Set<string>>();
  const add = (name: string, tools: string[]) => {
    const set = guards.get(name) ?? new Set<string>();
    for (const t of tools) set.add(t);
    guards.set(name, set);
  };
  let codedChecks = false;
  for (const f of tree.files) {
    if (executableKind(f.path) !== "go" || /_test\.go$/i.test(f.path)) continue;
    const lex = goLexOf(f);
    if (!lex) continue;
    const base = /([^/]+)\.go$/i.exec(f.path)![1]!;
    const { checks, strayHook } = goChecks(lex.toks);
    let plain = checks.length === 0;
    for (const c of checks) {
      const hooks = c.tags.map(hookTag).filter((h) => h !== null);
      if (hooks.length === 0 && c.tagsKnown) {
        plain = true;
        continue;
      }
      add(c.id ?? base, c.tagsKnown ? [...new Set(hooks.flatMap((h) => h.tools))] : ["*"]);
    }
    if (strayHook) add(base, ["*"]);
    if (plain) codedChecks = true;
  }
  declaredGuards(tree, add);
  return { guards: [...guards].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, tools]) => ({ name, tool_calls: [...tools].sort() })), codedChecks };
}

/** Step 6: the capability set and the pre-install manifest body of an archive, read from its files. */
export function extractCapabilities(tree: Tree, manifest: PackManifest | null): Extraction {
  const { guards, codedChecks } = guardsAndChecks(tree);
  const tasks: TaskFacts[] = [];
  for (const f of tree.files) {
    const m = /^tasks\/([^/]+)\/task\.json$/.exec(f.path);
    if (m) tasks.push(taskFacts(m[1]!, readJson(tree, f.path)));
  }
  tasks.sort((a, b) => (a.name < b.name ? -1 : 1));
  const declaredEnv = manifest?.envSetup;
  const envSetup = tree.files.some((f) => isEnvSetupPath(f.path)) || truthy(declaredEnv);
  const forced = forcedSkillsOf(tree, manifest);
  const used = usedActionsOf(tree);
  const declared = (Array.isArray(manifest?.githubActions) ? (manifest.githubActions as unknown[]) : []).filter((a): a is string => typeof a === "string" && a.trim() !== "").map(normaliseAction);
  const actions = [...new Set([...declared, ...used.map((u) => u.name)])].filter(Boolean).sort();

  const caps = new Set<Capability>();
  if (guards.length) caps.add("guard");
  if (codedChecks) caps.add("coded-check");
  if (tasks.length) caps.add("task");
  for (const t of tasks) {
    if (t.opens_pr) caps.add("task:opens-pr");
    if (t.agentic_phase) caps.add("task:agentic-phase");
  }
  if (envSetup) caps.add("env-setup");
  if (forced.length) caps.add("forced-skill");
  for (const a of actions) caps.add(`github-action:${a}`);

  return {
    capabilities: [...caps].sort(),
    preinstall: { guards, tasks, forced_skills: forced, github_actions: actions },
    usedActions: used,
    declaredActions: declared,
  };
}
