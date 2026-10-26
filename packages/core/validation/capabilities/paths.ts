import type { Tree, TreeFile } from "../../canonical/index.ts";

export type Executable = "go" | "js" | "shell" | "other";

const JS = /\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/i;
const SHELL = /\.(?:sh|bash|zsh)$/i;
const OTHER = /\.(?:py|rb|pl|ps1|php|lua)$/i;
// Data and prose that sit beside a task's code and are never run.
const DATA = /\.(?:json|jsonc|md|markdown|txt|ya?ml|toml|csv|svg|html?|css|lock)$/i;

export const isEnvSetupPath = (path: string): boolean => /^(?:env|env-setup)\//i.test(path) || /^env-setup(?:\.[^/]+)?$/i.test(path);

/**
 * What cn would run, by where the file sits: coded checks, task code and env setup. A file a
 * `task.json` names as its worker, or `pack.json` names as env setup, is code whatever its extension;
 * so is any file under tasks/ that is not plainly data.
 */
export function executableKind(path: string, declared: ReadonlySet<string> = new Set()): Executable | null {
  const inCode = /^checks\//i.test(path);
  const inTask = /^tasks\//i.test(path);
  const env = isEnvSetupPath(path);
  const named = declared.has(path);
  if (!inCode && !inTask && !env && !named) return null;
  if (inCode && /\.go$/i.test(path)) return "go";
  if (JS.test(path)) return "js";
  if (SHELL.test(path)) return "shell";
  if (OTHER.test(path)) return "other";
  if (named) return "shell";
  if (DATA.test(path)) return null;
  return inCode ? null : "shell";
}

/** A file written with a shebang for another interpreter is read as that language. */
export function refineKind(kind: Executable, file: TreeFile): Executable {
  if (kind !== "shell") return kind;
  if (file.content[0] !== 0x23 || file.content[1] !== 0x21) {
    // No shebang and no shell extension: JavaScript syntax at the start of a line decides, since a shell reading it would find nothing to judge.
    if (SHELL.test(file.path)) return kind;
    const sample = new TextDecoder().decode(file.content.subarray(0, 4096));
    return /^\s*(?:import\s[^\n]*['"]|export\s|(?:const|let|var)\s+[\w{[][^\n]*=|[^\n]*\brequire\s*\()/m.test(sample) ? "js" : kind;
  }
  const head = new TextDecoder().decode(file.content.subarray(0, 120)).split("\n", 1)[0]!;
  if (/\b(?:node|deno|bun)\b/.test(head)) return "js";
  if (/\b(?:python3?|ruby|perl|pwsh)\b/.test(head)) return "other";
  return kind;
}

const WORKER_KEY = /^(?:code_)?worker(?:_\w+)?$/i;

/** Files that `task.json` and `pack.json` name as code to run. */
export function declaredCodePaths(tree: Tree, packEnvSetup: unknown): Set<string> {
  const out = new Set<string>();
  for (const e of Array.isArray(packEnvSetup) ? packEnvSetup : [packEnvSetup]) if (typeof e === "string") out.add(e.replace(/^\.\//, ""));
  for (const f of tree.files) {
    const m = /^(tasks\/[^/]+)\/task\.json$/.exec(f.path);
    if (!m) continue;
    try {
      const task = JSON.parse(new TextDecoder().decode(f.content).replace(/^\uFEFF/, "")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(task)) if (WORKER_KEY.test(k) && typeof v === "string") out.add(`${m[1]}/${v.replace(/^\.\//, "")}`);
    } catch {
      // an unreadable task.json is the sandbox's finding
    }
  }
  return out;
}
