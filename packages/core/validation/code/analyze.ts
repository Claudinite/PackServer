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

export interface GoCheck {
  /** The `ID:` of the check, or null when it is not a plain string. */
  id: string | null;
  tags: string[];
  /** False when `Tags:` is not a literal list of strings, so what it names cannot be read. */
  tagsKnown: boolean;
  line: number;
}

const HOOK_EVENTS = new Set(["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "SubagentStop", "Notification", "PreCompact"]);

/** A tag names a hook event when it is a known one, or is written as an event is (leading capital) rather than as a plain tag such as `world`. */
export function hookTag(tag: string): { event: string; tools: string[] } | null {
  const m = /^([A-Za-z]+)\s*(?:[:(]\s*(.*?)\)?)?$/.exec(tag.trim());
  const event = m?.[1];
  if (!event || !(HOOK_EVENTS.has(event) || /^[A-Z]/.test(event))) return null;
  const tools = (m[2] ?? "").split("|").map((t) => t.trim()).filter(Boolean);
  return { event, tools: tools.length ? tools : ["*"] };
}

export interface GoChecks {
  checks: GoCheck[];
  /** The file names a hook event or hook registration somewhere a `Register(Check{...})` call does not account for. */
  strayHook: boolean;
}

/** `checksdk.Register(checksdk.Check{ID: ..., Tags: []string{...}})` calls, whatever the SDK import is called. */
export function goChecks(toks: readonly Tok[]): GoChecks {
  const checks: GoCheck[] = [];
  let strayHook = false;
  const claimed = new Set<number>();
  for (let n = 0; n < toks.length; n++) {
    const t = toks[n]!;
    if (t.k === "id" && t.v === "Register" && toks[n + 1]?.v === "(" && toks[n + 1]!.k === "p") {
      let depth = 0;
      let end = n + 1;
      for (; end < toks.length; end++) {
        const x = toks[end]!;
        if (x.k !== "p") continue;
        if (x.v === "(") depth++;
        else if (x.v === ")" && --depth === 0) break;
      }
      const check: GoCheck = { id: null, tags: [], tagsKnown: true, line: t.line };
      for (let m = n + 2; m < end; m++) {
        const x = toks[m]!;
        if (x.k !== "id" || toks[m + 1]?.v !== ":") continue;
        if (x.v === "ID" && toks[m + 2]?.k === "str") check.id = toks[m + 2]!.v;
        if (x.v === "Tags") {
          let k = m + 2;
          if (toks[k]?.k === "id" && toks[k]!.v === "string") {
            k++;
            for (; k < end && (toks[k]!.k === "str" || toks[k]!.v === ","); k++) {
              claimed.add(k);
              if (toks[k]!.k === "str") check.tags.push(toks[k]!.v);
            }
          } else check.tagsKnown = false;
        }
      }
      checks.push(check);
    }
  }
  for (let n = 0; n < toks.length; n++) {
    const t = toks[n]!;
    if (t.k === "str" && HOOK_EVENTS.has(t.v) && !claimed.has(n)) strayHook = true;
    if (t.k === "id" && (t.v === "RegisterHook" || HOOK_EVENTS.has(t.v))) strayHook = true;
    if (t.k === "id" && t.v === "Register" && toks[n + 1]?.v !== "(") strayHook = true;
  }
  return { checks, strayHook };
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
