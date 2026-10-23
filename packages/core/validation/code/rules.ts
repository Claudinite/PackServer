import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { goImports, jsImports } from "./analyze.ts";
import { GO_STDLIB, isCheckSdk, isEngineSdk, isGoNetwork } from "./go-stdlib.ts";
import type { GoLex } from "./golex.ts";
import type { JsLex } from "./js.ts";
import { foldString, matchBracket } from "./fold.ts";
import type { Tok } from "./tokens.ts";

export interface Source {
  file: string;
  text: string;
}

const PER_RULE_PER_FILE = 25;

const clip = (s: string) => (s.length > 100 ? s.slice(0, 100) : s).replace(/\s+/g, " ");

type Where = { file: string; line: number; quote?: string; hint: string };
type Emit = (rule: string, where: Where) => void;

function emitter(out: Finding[], make: MakeFinding): Emit {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  return (rule, w) => {
    const bucket = `${rule}\0${w.file}`;
    const n = counts.get(bucket) ?? 0;
    // A report keeps 25 findings of one rule per file, so the rest are never built.
    if (n >= PER_RULE_PER_FILE) return;
    const key = `${bucket}\0${w.line}\0${w.quote ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    counts.set(bucket, n + 1);
    out.push(make(rule, { file: w.file, line: w.line, quote: w.quote ?? null, hint: w.hint }));
  };
}

const NETWORK_HINT = "Checks, guards, task workers and env setup may not open network connections, and there is no exception to declare.";
const EVAL_HINT = "Code that builds or loads other code at run time cannot be read in advance. Write the logic out.";

// --- Go -------------------------------------------------------------------------------------

const GO_DANGEROUS_IMPORTS = new Set(["plugin", "os/exec"]);
const GO_EXEC_NAMES = new Set(["StartProcess", "ForkExec"]);
const GO_CLOCK = new Set(["Now", "Since", "Until"]);

export function goRules(src: Source, lex: GoLex, emit: Emit): void {
  const { toks, directives } = lex;
  const clocks: number[] = [];
  for (const imp of goImports(toks)) {
    const std = GO_STDLIB.has(imp.spec);
    if (!std && !isCheckSdk(imp.spec)) {
      emit("code.foreign-import", { file: src.file, line: imp.line, quote: `import "${clip(imp.spec)}"`, hint: "A coded check may import only the public check SDK and the Go standard library." });
    }
    if (std && isGoNetwork(imp.spec)) emit("code.network", { file: src.file, line: imp.line, quote: `import "${imp.spec}"`, hint: NETWORK_HINT });
    if (std && GO_DANGEROUS_IMPORTS.has(imp.spec)) emit("code.eval", { file: src.file, line: imp.line, quote: `import "${imp.spec}"`, hint: imp.spec === "os/exec" ? "Running an external program hides what it does from review." : EVAL_HINT });
    if (imp.spec === "encoding/base64") emit("code.base64", { file: src.file, line: imp.line, quote: `import "${imp.spec}"`, hint: "Decoding base64 in a check can hide what it runs. Keep readable text readable." });
  }
  for (const d of directives) {
    if (/^\/\/go:(?:linkname|cgo_)/.test(d.text)) emit("code.eval", { file: src.file, line: d.line, quote: clip(d.text), hint: "This directive reaches runtime internals that bypass the import allowlist." });
  }
  for (let n = 0; n + 2 < toks.length; n++) {
    const t = toks[n]!;
    if (t.k === "id" && GO_EXEC_NAMES.has(t.v) && toks[n - 1]?.v === ".") emit("code.eval", { file: src.file, line: t.line, quote: `.${t.v}`, hint: "Running an external program hides what it does from review." });
    if (t.k === "id" && t.v === "Exec" && toks[n - 1]?.v === "." && toks[n - 2]?.v === "syscall") emit("code.eval", { file: src.file, line: t.line, quote: "syscall.Exec", hint: "Running an external program hides what it does from review." });
    if (t.k === "id" && t.v === "time" && toks[n + 1]!.v === "." && GO_CLOCK.has(toks[n + 2]!.v)) clocks.push(n);
  }
  timeRules(toks, clocks, src, emit);
  base64Strings(toks, src, emit);
}

// --- JavaScript -------------------------------------------------------------------------------

const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window", "global"]);
const NETWORK_GLOBALS = new Set(["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "RTCPeerConnection", "WebTransport"]);
const EVAL_GLOBALS = new Set(["eval", "Function", "AsyncFunction", "GeneratorFunction", "WebAssembly", "createRequire", "getBuiltinModule"]);
const PROCESS_ESCAPES = new Set(["binding", "dlopen", "getBuiltinModule", "mainModule", "_linkedBinding"]);
const TIMER_STRINGS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const CLOCK_METHODS = new Set(["now", "getTime", "valueOf"]);
const COMPARATORS = new Set(["<", ">", "<=", ">=", "==", "!=", "===", "!==", "?", "&&", "||"]);
const CALENDAR_GETTERS = new Set(["Year", "Month", "Day", "Weekday", "YearDay", "Hour", "Minute", "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours"]);
const DATE_STRING = /^\d{4}-\d{2}(?:-\d{2})?/;
/** A number the size of an epoch timestamp (seconds or milliseconds), or a date written out. */
function isDateConstant(t: Tok): boolean {
  if (t.k === "num") return /^\d{10,}$/.test(t.v.replace(/_/g, ""));
  return t.k === "str" && DATE_STRING.test(t.v);
}
const DYNAMIC_HINT = "A name or object built at run time cannot be checked against the network and eval rules. Write the name out, or do not reach the global object this way.";

const isP = (t: Tok | undefined, v: string) => t?.k === "p" && t.v === v;

function propertyOf(toks: readonly Tok[], n: number): string | null {
  const before = toks[n - 1];
  if (!isP(before, ".") && !isP(before, "?.")) return null;
  const owner = toks[n - 2];
  return owner?.k === "id" ? owner.v : "";
}

const REFLECT_READS = new Set(["get", "getOwnPropertyDescriptor"]);

/** `Reflect.get(globalThis, key)` is computed access in a call: judge the key when it folds, hold when it cannot. */
function reflectRule(toks: readonly Tok[], open: number, at: Tok, say: (kind: "network" | "eval" | "dynamic", t: Tok, quote: string) => void): void {
  const close = matchBracket(toks, open);
  if (close === -1) return say("dynamic", at, "Reflect.get(...)");
  let depth = 0;
  let comma = -1;
  let end = close;
  for (let k = open + 1; k < close; k++) {
    const x = toks[k]!;
    if (x.k !== "p") continue;
    if (x.v === "(" || x.v === "[") depth++;
    else if (x.v === ")" || x.v === "]") depth--;
    else if (x.v === "," && depth === 0) {
      if (comma === -1) comma = k;
      else {
        end = k;
        break;
      }
    }
  }
  const key = comma === -1 ? null : foldString(toks, comma + 1, end);
  const judged = judgeName(key);
  if (judged && (key !== null || /^(?:globalThis|self|window|global)$/.test(toks[open + 1]?.v ?? "") || judged === "dynamic")) say(judged, at, "Reflect.get(...)");
}

/** What reaching a name through the global object means: fail for a banned name, hold when the name cannot be read. */
function judgeName(name: string | null): "network" | "eval" | "dynamic" | null {
  if (name === null) return "dynamic";
  if (NETWORK_GLOBALS.has(name)) return "network";
  if (EVAL_GLOBALS.has(name) || name === "constructor") return "eval";
  return null;
}

export function jsRules(src: Source, lex: JsLex, emit: Emit, path = src.file, present: ReadonlySet<string> = new Set()): void {
  const { toks, regexBodies } = lex;
  const clocks: number[] = [];
  const { specs, dynamic } = jsImports(toks);
  const seenSpec = new Set<string>();
  for (const imp of specs) {
    const key = `${imp.spec}\0${imp.line}`;
    if (seenSpec.has(key)) continue;
    seenSpec.add(key);
    if (isEngineSdk(imp.spec) || isLocalImport(path, imp.spec, present)) continue;
    emit("code.foreign-import", { file: src.file, line: imp.line, quote: `import "${clip(imp.spec)}"`, hint: "A task worker may import only @claudinite/sdk and its own files in the pack." });
  }
  for (const d of dynamic) emit("code.foreign-import", { file: src.file, line: d.line, hint: "An import or require whose target is not a plain string cannot be checked against the allowlist." });

  const say = (kind: "network" | "eval" | "dynamic", t: Tok, quote: string) => {
    if (kind === "network") emit("code.network", { file: src.file, line: t.line, quote, hint: NETWORK_HINT });
    else if (kind === "eval") emit("code.eval", { file: src.file, line: t.line, quote, hint: EVAL_HINT });
    else emit("code.dynamic-access", { file: src.file, line: t.line, quote, hint: DYNAMIC_HINT });
  };

  // Names that stand for the global object: `const g = globalThis`.
  const globals = new Set(GLOBAL_OBJECTS);
  for (let n = 1; n + 1 < toks.length; n++) {
    const t = toks[n]!;
    const rhs = toks[n + 1]!;
    if (isP(t, "=") && !t.afterBrace && rhs.k === "id" && globals.has(rhs.v) && !isP(toks[n + 2], ".") && !isP(toks[n + 2], "?.") && !isP(toks[n + 2], "[") && toks[n - 1]!.k === "id") globals.add(toks[n - 1]!.v);
  }

  for (let n = 0; n < toks.length; n++) {
    const t = toks[n]!;
    if (t.k === "str") {
      if (NETWORK_GLOBALS.has(t.v)) say("network", t, `"${t.v}"`);
      else if (t.v === "eval" || t.v === "Function" || t.v === "constructor") say("eval", t, `"${t.v}"`);
      if (t.v === "base64" || t.v === "base64url") emit("code.base64", { file: src.file, line: t.line, quote: `"${t.v}"`, hint: "Decoding base64 in a worker can hide what it runs. Keep readable text readable." });
      continue;
    }
    if (t.k !== "id") continue;
    const owner = propertyOf(toks, n);
    const global = owner === null || globals.has(owner) || owner === "this";
    if (global && NETWORK_GLOBALS.has(t.v)) say("network", t, t.v);
    if (t.v === "sendBeacon" && owner !== null) say("network", t, t.v);
    if (EVAL_GLOBALS.has(t.v) && (global || t.v === "getBuiltinModule" || t.v === "createRequire")) say("eval", t, t.v);
    if (owner === "process" && PROCESS_ESCAPES.has(t.v)) say("eval", t, `process.${t.v}`);
    if (t.v === "constructor" && owner !== null) say("eval", t, ".constructor");
    if (TIMER_STRINGS.has(t.v) && isP(toks[n + 1], "(") && toks[n + 2]?.k === "str") say("eval", t, `${t.v}("...")`);
    if (t.v === "atob") emit("code.base64", { file: src.file, line: t.line, quote: t.v, hint: "Decoding base64 in a worker can hide what it runs. Keep readable text readable." });
    if (t.v === "Date" && global && owner === null && isP(toks[n + 1], ".") && CLOCK_METHODS.has(toks[n + 2]?.v ?? "") && isP(toks[n + 3], "(")) clocks.push(n);
    if (t.v === "Date" && toks[n - 1]?.v === "new" && isP(toks[n + 1], "(") && isP(toks[n + 2], ")")) clocks.push(n);

    if (owner === null && (globals.has(t.v) || t.v === "process")) {
      // `globalThis.self.window[...]`: follow a chain of names that all stand for the global object.
      let m = n;
      if (t.v !== "process") while ((isP(toks[m + 1], ".") || isP(toks[m + 1], "?.")) && globals.has(toks[m + 2]?.v ?? "") && toks[m + 2]!.k === "id") m += 2;
      const next = toks[m + 1];
      const bracket = isP(next, "[") ? m + 1 : isP(next, "?.") && isP(toks[m + 2], "[") ? m + 2 : -1;
      if (bracket !== -1) {
        const close = matchBracket(toks, bracket);
        const key = close === -1 ? null : foldString(toks, bracket + 1, close);
        const judged = t.v === "process" ? (key !== null && PROCESS_ESCAPES.has(key) ? "eval" : key === null ? "dynamic" : null) : judgeName(key);
        if (judged) say(judged, t, `${t.v}[...]`);
      } else if (globals.has(t.v) && m === n && !isP(next, ".") && !isP(next, "?.") && toks[n - 1]?.v !== "typeof") {
        const assigned = isP(toks[n - 1], "=") && !toks[n - 1]!.afterBrace && toks[n - 2]?.k === "id";
        if (isP(toks[n - 1], "=") && toks[n - 1]!.afterBrace) say("dynamic", t, `${t.v} taken apart`);
        else if (!assigned) say("dynamic", t, `${t.v} used as a value`);
      }
    }
    if (t.v === "Reflect" && isP(toks[n + 1], ".") && REFLECT_READS.has(toks[n + 2]?.v ?? "") && isP(toks[n + 3], "(")) reflectRule(toks, n + 3, t, say);
  }
  // Any computed key that folds to `constructor` reaches the Function constructor, whatever it is read from.
  for (let n = 1; n < toks.length; n++) {
    const t = toks[n]!;
    if (!isP(t, "[") || !(toks[n - 1]!.k === "id" || isP(toks[n - 1], ")") || isP(toks[n - 1], "]"))) continue;
    const next = toks[n + 1];
    if (next?.k === "str" && next.v === "constructor") continue;
    const close = matchBracket(toks, n, 40);
    if (close !== -1 && foldString(toks, n + 1, close) === "constructor") say("eval", t, "[...constructor]");
  }
  for (const r of regexBodies) {
    if (/\b(?:fetch|XMLHttpRequest|WebSocket)\b/.test(r.v)) emit("code.network", { file: src.file, line: r.line, quote: clip(r.v), hint: NETWORK_HINT });
    if (/\b(?:eval|Function)\b/.test(r.v)) emit("code.eval", { file: src.file, line: r.line, quote: clip(r.v), hint: EVAL_HINT });
  }
  timeRules(toks, clocks, src, emit);
  base64Strings(toks, src, emit);
}

/** A relative import of a file the pack ships beside the worker; that file is read as code too. */
function isLocalImport(from: string, spec: string, present: ReadonlySet<string>): boolean {
  if (!/^\.{1,2}\//.test(spec) || /[\\\0]/.test(spec)) return false;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const resolved = parts.join("/");
  return /^tasks\/[^/]+\//.test(resolved) && /^tasks\/[^/]+\//.test(from) && present.has(resolved) && /\.(?:mjs|js|cjs)$/.test(resolved);
}

// --- time-conditional behaviour ---------------------------------------------------------------

const TIME_HINT = "Behaviour that depends on the date can pass review today and change later. Remove the clock from the decision.";

/**
 * A clock read matters when the date itself decides something: its line compares against a date constant or reads a calendar
 * field (weekday, month, year, hour). Age arithmetic, formatting and storing a timestamp steer nothing.
 */
function timeRules(toks: readonly Tok[], clocks: readonly number[], src: Source, emit: Emit): void {
  if (clocks.length === 0) return;
  const calendar = new Set<number>();
  const compares = new Set<number>();
  const constants = new Set<number>();
  toks.forEach((t, n) => {
    if (t.k === "id" && CALENDAR_GETTERS.has(t.v) && isP(toks[n + 1], "(")) calendar.add(t.line);
    if (t.k === "p" && COMPARATORS.has(t.v)) compares.add(t.line);
    if (isDateConstant(t)) constants.add(t.line);
  });
  const decides = (line: number) => calendar.has(line) || (compares.has(line) && constants.has(line));
  const stored = new Set<string>();
  for (const at of clocks) {
    const t = toks[at]!;
    if (decides(t.line)) {
      emit("code.time-conditional", { file: src.file, line: t.line, quote: excerpt(src.text, t.i, 12), hint: TIME_HINT });
      continue;
    }
    // `now := time.Now()` or `const t = new Date()`: follow the variable.
    let op = at - 1;
    if (toks[op]?.v === "new") op--;
    const name = toks[op - 1];
    if ((isP(toks[op], ":=") || isP(toks[op], "=")) && name?.k === "id" && name.line === t.line) stored.add(name.v);
  }
  if (stored.size === 0) return;
  toks.forEach((t, k) => {
    if (t.k === "id" && stored.has(t.v) && decides(t.line) && !isP(toks[k + 1], ":=") && !isP(toks[k + 1], "=")) {
      emit("code.time-conditional", { file: src.file, line: t.line, quote: excerpt(src.text, t.i, t.v.length), hint: TIME_HINT });
    }
  });
}

const BLOB = /^[A-Za-z0-9+/_-]{200,}={0,2}$/;

function base64Strings(toks: readonly Tok[], src: Source, emit: Emit): void {
  for (const t of toks) {
    if (t.k === "str" && t.len >= 200 && BLOB.test(t.v)) emit("code.base64", { file: src.file, line: t.line, quote: `(${t.len} base64-like characters)`, hint: "A long encoded string in code can hide a payload. Keep readable text readable." });
  }
}

// --- other languages --------------------------------------------------------------------------

const OTHER_NETWORK = /\b(?:socket|urllib\d?|urlopen|requests|httpx|aiohttp|http\.client|Net::HTTP|open-uri|LWP|Invoke-WebRequest|Invoke-RestMethod|Test-NetConnection|System\.Net)\b/;

export function otherRules(src: Source, emit: Emit): void {
  let line = 0;
  for (const raw of src.text.split("\n")) {
    line++;
    if (OTHER_NETWORK.test(raw)) emit("code.network", { file: src.file, line, quote: excerpt(raw, 0, raw.length), hint: NETWORK_HINT });
  }
}

export { emitter };
export type { Emit };
