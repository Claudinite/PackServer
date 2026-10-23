import type { Capability, CapabilitySet, PreInstallManifest } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { decodeText } from "../engine/files.ts";
import { rawDoc } from "../text/doc.ts";
import { goRegistrations, isGuardEvent } from "../code/analyze.ts";
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

export const normaliseAction = (name: string): string => name.trim().split("@")[0]!.replace(/\/+$/, "").toLowerCase();

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
  const trigger = task.trigger;
  if (typeof trigger === "string" && trigger.trim()) return trigger.trim();
  const t = asObject(trigger);
  for (const key of ["schedule", "cron", "cadence"]) {
    const v = t?.[key] ?? task[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "manual";
}

const AGENTIC_KEYS = ["agentic", "agenticPhase", "agentic_phase", "agent", "agentPrompt", "prompt"];
const PR_KEYS = ["pr", "opensPr", "opens_pr", "pullRequest"];

interface TaskFacts {
  name: string;
  cadence: string;
  opens_pr: boolean;
  agentic_phase: boolean;
}

function taskFacts(name: string, json: { ok: boolean; value: unknown } | null): TaskFacts {
  const task = json?.ok ? asObject(json.value) : null;
  // A task.json that cannot be read claims everything, so the widening check never undercounts it.
  if (!task) return { name, cadence: "manual", opens_pr: true, agentic_phase: true };
  return {
    name,
    cadence: scheduleOf(task),
    opens_pr: PR_KEYS.some((k) => truthy(task[k])),
    agentic_phase: AGENTIC_KEYS.some((k) => truthy(task[k])),
  };
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

function guardsAndChecks(tree: Tree): { guards: PreInstallBody["guards"]; codedChecks: boolean } {
  const guards = new Map<string, Set<string>>();
  let codedChecks = false;
  for (const f of tree.files) {
    if (executableKind(f.path) !== "go" || /_test\.go$/i.test(f.path)) continue;
    const lex = goLexOf(f);
    if (!lex) continue;
    const regs = goRegistrations(lex.toks);
    const name = /([^/]+)\.go$/i.exec(f.path)![1]!;
    const guardRegs = regs.filter((r) => isGuardEvent(r.event));
    if (guardRegs.length) {
      const tools = guards.get(name) ?? new Set<string>();
      for (const r of guardRegs) for (const t of r.tools) tools.add(t);
      guards.set(name, tools);
    }
    if (regs.length === 0 || regs.some((r) => !isGuardEvent(r.event))) codedChecks = true;
  }
  // A declared check that names a PreToolUse hook is a guard too.
  const declared = readJson(tree, "declared-checks.json");
  const list = asObject(declared?.value)?.checks;
  if (Array.isArray(list)) {
    for (const c of list) {
      const o = asObject(c);
      const event = o?.event ?? o?.hook;
      const eventName = typeof event === "string" ? event : (asObject(event)?.event as unknown);
      if (typeof eventName !== "string" || eventName.toLowerCase() !== "pretooluse") continue;
      const id = typeof o?.id === "string" ? o.id.split("/").pop()! : `declared-${guards.size + 1}`;
      const raw = o?.tools ?? o?.tool ?? o?.matcher ?? asObject(event)?.tools;
      const tools = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("|") : []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
      const set = guards.get(id) ?? new Set<string>();
      for (const t of tools.length ? tools : ["*"]) set.add(t);
      guards.set(id, set);
    }
  }
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
