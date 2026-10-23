import type { TreeFile } from "../../canonical/index.ts";

export type Executable = "go" | "js" | "shell" | "other";

const JS = /\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/i;
const SHELL = /\.(?:sh|bash|zsh)$/i;
const OTHER = /\.(?:py|rb|pl|ps1|php|lua)$/i;

export const isEnvSetupPath = (path: string): boolean => /^(?:env|env-setup)\//i.test(path) || /^env-setup(?:\.[^/]+)?$/i.test(path);

/** What cn would run, by where the file sits: coded checks, task workers and env setup. */
export function executableKind(path: string, declaredEnvSetup: ReadonlySet<string> = new Set()): Executable | null {
  const inCode = /^checks\//i.test(path);
  const inTask = /^tasks\//i.test(path);
  const env = isEnvSetupPath(path) || declaredEnvSetup.has(path);
  if (!inCode && !inTask && !env) return null;
  if (inCode && /\.go$/i.test(path)) return "go";
  if (JS.test(path)) return inCode ? null : "js";
  if (SHELL.test(path)) return "shell";
  if (OTHER.test(path)) return "other";
  return env ? "shell" : null;
}

/** An env-setup file written with a shebang for another interpreter is read as that language. */
export function refineKind(kind: Executable, file: TreeFile): Executable {
  if (kind !== "shell" || file.content[0] !== 0x23 || file.content[1] !== 0x21) return kind;
  const head = new TextDecoder().decode(file.content.subarray(0, 120)).split("\n", 1)[0]!;
  if (/\b(?:node|deno|bun)\b/.test(head)) return "js";
  if (/\b(?:python3?|ruby|perl|pwsh)\b/.test(head)) return "other";
  return kind;
}
