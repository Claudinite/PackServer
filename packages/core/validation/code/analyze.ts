import type { Tok } from "./tokens.ts";

export interface Import {
  spec: string;
  line: number;
}

/** Every import of a Go file: grouped, aliased, dot and blank forms alike. */
export function goImports(toks: readonly Tok[]): Import[] {
  const out: Import[] = [];
  const spec = (t: Tok | undefined) => (t?.k === "str" ? t : null);
  for (let n = 0; n < toks.length; n++) {
    const t = toks[n]!;
    if (t.k !== "id" || t.v !== "import") continue;
    const next = toks[n + 1];
    if (next?.k === "p" && next.v === "(") {
      let m = n + 2;
      for (; m < toks.length && !(toks[m]!.k === "p" && toks[m]!.v === ")"); m++) {
        const s = spec(toks[m]);
        if (s) out.push({ spec: s.v, line: s.line });
      }
      n = m;
    } else {
      const s = spec(next) ?? spec(toks[n + 2]);
      if (s) out.push({ spec: s.v, line: s.line });
    }
  }
  return out;
}

export interface Registration {
  event: string;
  /** Tool names the hook judges; `*` when the matcher is not a plain string. */
  tools: string[];
  line: number;
}

const NON_GUARD_EVENTS = new Set(["PostToolUse", "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "SubagentStop", "Notification", "PreCompact"]);
export const isGuardEvent = (event: string): boolean => !NON_GUARD_EVENTS.has(event);

/** `RegisterHook(check.PreToolUse, "Bash|Edit", fn)` calls, however the SDK package is imported. */
export function goRegistrations(toks: readonly Tok[]): Registration[] {
  const out: Registration[] = [];
  for (let n = 0; n + 4 < toks.length; n++) {
    const t = toks[n]!;
    if (t.k !== "id" || t.v !== "RegisterHook" || toks[n + 1]!.v !== "(") continue;
    let m = n + 2;
    if (toks[m + 1]?.v === "." && toks[m]!.k === "id") m += 2;
    const event = toks[m];
    if (!event || (event.k !== "id" && event.k !== "str")) continue;
    const matcher = toks[m + 2];
    const tools = matcher?.k === "str" && toks[m + 1]?.v === "," ? matcher.v.split("|").map((s) => s.trim()).filter(Boolean) : ["*"];
    out.push({ event: event.v, tools: tools.length ? tools : ["*"], line: t.line });
  }
  return out;
}

export interface JsImports {
  specs: Import[];
  /** An import or require whose specifier is not a plain literal, or a bare `require`. */
  dynamic: { line: number }[];
}

/** Static, dynamic and CommonJS imports, with the specifier resolved from its literal. */
export function jsImports(toks: readonly Tok[]): JsImports {
  const specs: Import[] = [];
  const dynamic: { line: number }[] = [];
  const isP = (t: Tok | undefined, v: string) => t?.k === "p" && t.v === v;
  const afterDot = (n: number) => isP(toks[n - 1], ".") || isP(toks[n - 1], "?.");
  // One backward pass finds, for every token, the nearest following `from "..."` and `;`, so no import rescans the file.
  const nextFrom = new Array<number>(toks.length + 1).fill(Infinity);
  const nextSemi = new Array<number>(toks.length + 1).fill(Infinity);
  for (let n = toks.length - 1; n >= 0; n--) {
    const t = toks[n]!;
    nextFrom[n] = t.k === "id" && t.v === "from" && toks[n + 1]?.k === "str" && !afterDot(n) ? n : nextFrom[n + 1]!;
    nextSemi[n] = isP(t, ";") ? n : nextSemi[n + 1]!;
  }
  const clauseSpec = (n: number) => {
    const m = nextFrom[n + 1]!;
    if (m < nextSemi[n + 1]!) specs.push({ spec: toks[m + 1]!.v, line: toks[m + 1]!.line });
  };
  for (let n = 0; n < toks.length; n++) {
    const t = toks[n]!;
    if (t.k !== "id" || afterDot(n)) continue;
    if (t.v === "require" || t.v === "import") {
      const next = toks[n + 1];
      if (isP(next, "(")) {
        const lit = toks[n + 2];
        if (lit?.k === "str" && isP(toks[n + 3], ")")) specs.push({ spec: lit.v, line: lit.line });
        else dynamic.push({ line: t.line });
      } else if (t.v === "require") {
        dynamic.push({ line: t.line });
      } else if (next?.k === "str") {
        specs.push({ spec: next.v, line: next.line });
      } else if (!isP(next, ".")) {
        clauseSpec(n);
      }
    } else if (t.v === "export") {
      clauseSpec(n);
    }
  }
  return { specs, dynamic };
}
