import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { isProse, type Doc } from "./doc.ts";
import { CURL_LONG, WGET_LONG } from "./upload-options.ts";

interface Word {
  text: string;
  start: number;
  /** A command or backtick substitution inside the word yields a credential. */
  sub: boolean;
}
interface Redir {
  op: string;
  target: Word | null;
}
interface Cmd {
  start: number;
  pipeStart: number;
  words: Word[];
  redirs: Redir[];
  /** The previous command in this pipeline produced credential content. */
  carry: boolean;
}
interface Frame {
  kind: 0 | 1 | 2;
  parens: number;
  groups: number;
  closed: boolean;
  quote: 0 | 1 | 2;
  cur: Word | null;
  redir: Redir | null;
  cmd: Cmd | null;
  inPipe: boolean;
  carry: boolean;
  pipeStart: number;
  last: boolean;
}
interface Hit {
  start: number;
  end: number;
}

const MAX_FRAMES = 8;
const MAX_NESTED_SCRIPTS = 2;
const MAX_HITS = 100;

const NONE: ReadonlySet<string> = new Set();
const WRAPPERS = new Map<string, ReadonlySet<string>>([
  ["sudo", new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"])],
  ["doas", new Set(["-u", "-C"])],
  ["nice", new Set(["-n"])],
  ["ionice", new Set(["-c", "-n", "-p"])],
  ["env", new Set(["-u", "-C", "-S"])],
  ["timeout", new Set(["-s", "-k"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["xargs", new Set(["-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "-l"])],
  ["time", NONE],
  ["nohup", NONE],
  ["command", NONE],
  ["exec", NONE],
  ["setsid", NONE],
]);
const KEYWORDS = new Set(["{", "if", "then", "else", "elif", "do", "while", "until", "!", "coproc"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);
const HTTP = new Set(["curl", "wget"]);
const STREAM = new Set(["nc", "ncat", "netcat", "socat", "telnet", "ssh"]);
const COPY = new Set(["scp", "rsync", "sftp"]);
const POWERSHELL = new Set(["invoke-webrequest", "invoke-restmethod", "iwr", "irm"]);
const READERS = new Set(["cat", "tac", "head", "tail", "less", "more", "strings", "base64", "xxd", "od", "hexdump", "gzip", "zcat", "bzip2", "xz", "tar", "zip", "openssl", "dd", "get-content", "gc", "type"]);

const CURL_VALUE_LETTERS = "HouAeXxwbcDmEyYzCrtPQ";
const CURL_PAYLOAD_LETTERS = "dFTK";
const CURL_PAYLOAD_LONG = new Set(["data", "data-ascii", "data-binary", "data-raw", "data-urlencode", "form", "form-string", "upload-file", "json", "config", "url-query", "variable"]);
const WGET_PAYLOAD_LONG = new Set(["post-file", "post-data", "body-file", "body-data"]);
const SCP_VALUE_LETTERS = "cDFiJloPSXRbs";
const RSYNC_VALUE_LETTERS = "efBT";
const RSYNC_VALUE_LONG = new Set(["--rsh", "--exclude", "--include", "--filter", "--exclude-from", "--include-from", "--files-from", "--rsync-path", "--log-file", "--password-file", "--temp-dir", "--partial-dir"]);

const CRED_HINT = /\.(?:ssh|aws|npmrc|netrc|gnupg|env)|id_(?:rsa|ed25519|ecdsa|dsa)/i;
const PATH_SPLIT = /[^\w.~$%-]+/;
const SSH_EXEMPT = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys"]);

/** A path that names a credential file or directory; public keys, known_hosts, ssh config and .env templates are not. */
const credMemo = new Map<string, boolean>();
function credFile(text: string): boolean {
  if (text.length > 256) return credPath(text);
  let r = credMemo.get(text);
  if (r === undefined) {
    if (credMemo.size >= 4096) credMemo.clear();
    r = credPath(text);
    credMemo.set(text, r);
  }
  return r;
}

function credPath(text: string): boolean {
  if (!CRED_HINT.test(text)) return false;
  const segs = text.toLowerCase().split(PATH_SPLIT);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === ".ssh") {
      const next = segs[i + 1] ?? "";
      if (next === "" || !(SSH_EXEMPT.has(next) || next.endsWith(".pub"))) return true;
    } else if (s === ".aws" || s === ".npmrc" || s === ".netrc" || s === ".gnupg") return true;
    else if (/^id_(?:rsa|ed25519|ecdsa|dsa)/.test(s)) {
      if (!s.endsWith(".pub")) return true;
    } else if (s === ".env") return true;
    else if (s.startsWith(".env.") && !/\.(?:example|sample|template)$/.test(s)) return true;
  }
  return false;
}

/** The option a long name stands for: an exact name, else the only option it prefixes. */
function resolveLong(name: string, table: readonly string[]): string | null {
  let lo = 0;
  let hi = table.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid]! < name) lo = mid + 1;
    else hi = mid;
  }
  const first = table[lo];
  if (first === undefined || !first.startsWith(name)) return null;
  if (first === name) return first;
  const second = table[lo + 1];
  return second !== undefined && second.startsWith(name) ? null : first;
}

// Variables that carry a credential. A path variable (from `X=<credential path>` or a loop over paths) counts
// only where the literal path would; a content variable (from a substitution that reads one) counts anywhere.
let credVars = new Map<string, "path" | "content">();
function refsVar(text: string, kind: "path" | "content"): boolean {
  if (credVars.size === 0 || text.indexOf("$") < 0) return false;
  for (const [v, k] of credVars) {
    if (k !== kind) continue;
    for (let at = text.indexOf("$" + v); at >= 0; at = text.indexOf("$" + v, at + 1)) {
      if (!/\w/.test(text[at + 1 + v.length] ?? "")) return true;
    }
    if (text.includes("${" + v + "}")) return true;
  }
  return false;
}
const refsContent = (text: string): boolean => refsVar(text, "content");
const credPathWord = (w: Word): boolean => w.sub || credFile(w.text) || refsVar(w.text, "path") || refsVar(w.text, "content");
const credWord = credPathWord;
const isFlag = (w: Word): boolean => w.text.length > 1 && w.text.charCodeAt(0) === 45;
const baseName = (t: string): string => {
  let b = t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1).toLowerCase();
  if (b.endsWith(".exe")) b = b.slice(0, -4);
  return b;
};
const isStdin = (v: string): boolean => v === "-" || v === "/dev/stdin" || v.endsWith("@-") || v.endsWith("<-");

function isRemote(t: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  const i = t.indexOf(":");
  if (i < 2) return false;
  const host = t.slice(0, i);
  return !host.includes("/") && !host.includes("\\");
}

interface Verdict {
  tainted: boolean;
  hit: boolean;
}

function httpVerdict(args: readonly Word[], stdinTainted: boolean, wget: boolean): boolean {
  if (args.some((a) => a.sub || refsContent(a.text))) return true;
  let stdinFlag = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    const t = a.text;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = resolveLong(eq < 0 ? t.slice(2) : t.slice(2, eq), wget ? WGET_LONG : CURL_LONG);
      if (name === null || !(wget ? WGET_PAYLOAD_LONG : CURL_PAYLOAD_LONG).has(name)) continue;
      const v = eq < 0 ? args[k + 1] : { text: t.slice(eq + 1), sub: a.sub, start: a.start };
      if (eq < 0) k++;
      if (!v) continue;
      if (isStdin(v.text)) stdinFlag = true;
      else if (credWord(v)) return true;
    } else if (!wget && t.length > 1 && t.charCodeAt(0) === 45) {
      for (let j = 1; j < t.length; j++) {
        const ch = t[j]!;
        const payload = CURL_PAYLOAD_LETTERS.includes(ch);
        if (!payload && !CURL_VALUE_LETTERS.includes(ch)) continue;
        const rest = t.slice(j + 1);
        const v = rest !== "" ? { text: rest, sub: a.sub, start: a.start } : args[k + 1];
        if (rest === "") k++;
        if (payload && v) {
          if (isStdin(v.text)) stdinFlag = true;
          else if (credWord(v)) return true;
        }
        break;
      }
    }
  }
  return stdinFlag && stdinTainted;
}

function copyVerdict(name: string, args: readonly Word[]): boolean {
  const letters = name === "rsync" ? RSYNC_VALUE_LETTERS : SCP_VALUE_LETTERS;
  const ops: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (!isFlag(a)) {
      ops.push(a);
      continue;
    }
    const t = a.text;
    if (t.charCodeAt(1) === 45) {
      if (name === "rsync" && !t.includes("=") && RSYNC_VALUE_LONG.has(t)) k++;
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      if (!letters.includes(t[j]!)) continue;
      if (j === t.length - 1) k++;
      break;
    }
  }
  if (ops.length < 2 || !isRemote(ops[ops.length - 1]!.text)) return false;
  for (let k = 0; k < ops.length - 1; k++) if (credWord(ops[k]!)) return true;
  return false;
}

function powershellVerdict(args: readonly Word[], carry: boolean): boolean {
  let body = false;
  for (const a of args) {
    if (isFlag(a)) {
      const colon = a.text.indexOf(":");
      const p = (colon < 0 ? a.text.slice(1) : a.text.slice(1, colon)).toLowerCase();
      if (p.length >= 2 && ("body".startsWith(p) || "infile".startsWith(p))) {
        body = true;
        if (colon >= 0 && credFile(a.text.slice(colon + 1))) return true;
        continue;
      }
    }
    if (body && credWord(a)) return true;
  }
  return body && carry;
}

function analyze(cmd: Cmd, depth: number): Verdict {
  const w = cmd.words;
  let k = 0;
  let envOnly = false;
  while (k < w.length) {
    const t = w[k]!.text;
    const assign = /^([A-Za-z_]\w*)=/.exec(t);
    if (assign) {
      const value = t.slice(assign[0].length);
      if (credVars.size < 16) {
        if (w[k]!.sub || refsContent(value)) credVars.set(assign[1]!, "content");
        else if (credFile(value) || refsVar(value, "path")) credVars.set(assign[1]!, "path");
      }
      k++;
      continue;
    }
    if (KEYWORDS.has(t)) {
      k++;
      continue;
    }
    const b = baseName(t);
    const valueFlags = WRAPPERS.get(b);
    if (valueFlags) {
      envOnly = b === "env";
      k++;
      while (k < w.length && isFlag(w[k]!)) {
        const flag = w[k++]!.text;
        if (valueFlags.has(flag) && k < w.length) k++;
      }
      if (b === "timeout" && k < w.length && /^\d/.test(w[k]!.text)) k++;
      continue;
    }
    envOnly = false;
    break;
  }
  const dump = k >= w.length && envOnly;
  const name = k < w.length ? baseName(w[k]!.text) : dump ? "env" : "";
  const args = k < w.length ? w.slice(k + 1) : [];
  if (name === "for" && args.length > 2 && args[1]!.text === "in" && credVars.size < 16 && args.slice(2).some(credWord)) credVars.set(args[0]!.text, "path");
  const redirected = cmd.redirs.some((r) => r.op.charCodeAt(0) === 60 && r.target !== null && credWord(r.target));
  const stdinTainted = cmd.carry || redirected;
  const stream = HTTP.has(name) || STREAM.has(name) || POWERSHELL.has(name) || COPY.has(name);

  let hit = false;
  if (HTTP.has(name)) hit = httpVerdict(args, stdinTainted, name === "wget");
  else if (STREAM.has(name)) hit = stdinTainted || args.some((a) => a.sub || refsContent(a.text)) || (name === "socat" && args.some((a) => !isFlag(a) && credPathWord(a)));
  else if (COPY.has(name)) hit = copyVerdict(name, args);
  else if (POWERSHELL.has(name)) hit = powershellVerdict(args, cmd.carry);
  else if (SHELLS.has(name) && depth < MAX_NESTED_SCRIPTS) {
    const scripts = name === "eval" ? [args.map((a) => a.text).join(" ")] : args.filter((_, i) => i > 0 && args[i - 1]!.text.endsWith("c") && isFlag(args[i - 1]!)).map((a) => a.text);
    hit = scripts.some((s) => scanText(s, depth + 1).length > 0);
  }

  const tainted =
    !stream &&
    (cmd.carry ||
      redirected ||
      dump ||
      (name === "printenv" && args.every(isFlag)) ||
      w.some((x) => x.sub || refsContent(x.text)) ||
      (READERS.has(name) && args.some((a) => !isFlag(a) && credPathWord(a))));
  return { tainted, hit };
}

function scanText(text: string, depth: number): Hit[] {
  const outer = credVars;
  credVars = new Map();
  try {
    return scanWords(text, depth);
  } finally {
    credVars = outer;
  }
}

function scanWords(text: string, depth: number): Hit[] {
  const hits: Hit[] = [];
  const n = text.length;
  const newFrame = (kind: 0 | 1 | 2): Frame => ({ kind, parens: 0, groups: 0, closed: false, quote: 0, cur: null, redir: null, cmd: null, inPipe: false, carry: false, pipeStart: 0, last: false });
  const stack: Frame[] = [newFrame(0)];
  let i = 0;

  const place = (f: Frame, w: Word): void => {
    if (!f.cmd) {
      f.cmd = { start: w.start, pipeStart: f.inPipe ? f.pipeStart : w.start, words: [], redirs: [], carry: f.inPipe && f.carry };
      f.pipeStart = f.cmd.pipeStart;
    }
    if (f.redir) {
      f.redir.target = w;
      f.redir = null;
    } else f.cmd.words.push(w);
  };
  const endWord = (f: Frame): void => {
    if (f.cur) {
      place(f, f.cur);
      f.cur = null;
    }
  };
  const word = (f: Frame, pos: number): Word => (f.cur ??= { text: "", start: pos, sub: false });
  const separate = (f: Frame, kind: string, end: number): void => {
    endWord(f);
    f.redir = null;
    if (f.cmd) {
      const lone = f.cmd.words.length === 1 && f.cmd.words[0]!.text === "}" && f.cmd.redirs.length === 0;
      if (!lone) {
        const v = analyze(f.cmd, depth);
        if (v.hit && hits.length < MAX_HITS) hits.push({ start: f.cmd.pipeStart, end });
        f.last = v.tainted;
        f.carry = v.tainted;
      }
      f.inPipe = kind === "|";
      f.closed = lone && kind !== "|";
      if (lone) f.carry = f.last;
      f.cmd = null;
    } else if (kind === "|" && f.closed) {
      f.inPipe = true;
      f.carry = f.last;
      f.closed = false;
    } else if (kind !== "\n") {
      f.inPipe = false;
      f.carry = false;
      f.closed = kind === ")";
    }
    if (kind === ")" && f.cmd === null) f.closed = true;
  };
  const close = (): void => {
    const f = stack.pop()!;
    separate(f, "end", i);
    word(stack[stack.length - 1]!, i).sub ||= f.last;
  };
  const open = (kind: 1 | 2, feed = false): void => {
    const parent = stack[stack.length - 1]!;
    word(parent, i);
    const inner = newFrame(kind);
    if (feed && parent.cmd?.carry) {
      inner.inPipe = true;
      inner.carry = true;
      inner.pipeStart = parent.cmd.pipeStart;
    }
    stack.push(inner);
  };

  while (i < n && hits.length < MAX_HITS) {
    const f = stack[stack.length - 1]!;
    const c = text.charCodeAt(i);
    if (f.quote === 1) {
      let j = i;
      while (j < n && text.charCodeAt(j) !== 39 && text.charCodeAt(j) !== 10) j++;
      word(f, i).text += text.slice(i, j);
      if (j < n && text.charCodeAt(j) === 39) j++;
      f.quote = 0;
      i = j;
      continue;
    }
    if (f.quote === 2) {
      if (c === 34) {
        f.quote = 0;
        i++;
      } else if (c === 10) f.quote = 0;
      else if (c === 92) {
        const nx = text.charCodeAt(i + 1);
        const w = word(f, i);
        if (nx === 34 || nx === 92 || nx === 36 || nx === 96) w.text += text[i + 1];
        else w.text += "\\" + (i + 1 < n ? text[i + 1]! : "");
        i += 2;
      } else if (c === 36 && text.charCodeAt(i + 1) === 40 && stack.length < MAX_FRAMES) {
        open(1);
        i += 2;
      } else if (c === 96 && f.kind === 2) {
        close();
        i++;
      } else if (c === 96 && stack.length < MAX_FRAMES) {
        open(2);
        i++;
      } else {
        let j = i + 1;
        for (; j < n; j++) {
          const d = text.charCodeAt(j);
          if (d === 34 || d === 92 || d === 36 || d === 96 || d === 10) break;
        }
        word(f, i).text += text.slice(i, j);
        i = j;
      }
      continue;
    }
    switch (c) {
      case 32:
      case 9:
      case 13:
      case 12:
      case 11:
        endWord(f);
        i++;
        break;
      case 10:
        separate(f, "\n", i);
        i++;
        break;
      case 92: {
        const nx = text.charCodeAt(i + 1);
        if (nx === 10) {
          endWord(f);
          i += 2;
        } else if (nx === 13 && text.charCodeAt(i + 2) === 10) {
          endWord(f);
          i += 3;
        } else {
          word(f, i).text += i + 1 < n ? "\\" + text[i + 1]! : "\\";
          i += 2;
        }
        break;
      }
      case 39:
        word(f, i);
        f.quote = 1;
        i++;
        break;
      case 34:
        word(f, i);
        f.quote = 2;
        i++;
        break;
      case 36:
        if (text.charCodeAt(i + 1) === 40 && stack.length < MAX_FRAMES) {
          open(1);
          i += 2;
        } else {
          word(f, i).text += "$";
          i++;
        }
        break;
      case 96:
        if (text.charCodeAt(i + 1) === 96 && text.charCodeAt(i + 2) === 96) {
          // a Markdown fence marker, not a substitution
          while (i < n && text.charCodeAt(i) === 96) i++;
          separate(f, "\n", i);
          break;
        }
        if (f.kind === 2) close();
        else if (stack.length < MAX_FRAMES) open(2);
        else word(f, i).text += "`";
        i++;
        break;
      case 40:
        if (f.cmd === null && f.cur === null && f.redir === null) {
          f.groups++;
          f.closed = false;
        } else {
          if (f.kind === 1) f.parens++;
          word(f, i).text += "(";
        }
        i++;
        break;
      case 41:
        if (f.groups > 0) {
          f.groups--;
          separate(f, ")", i);
        } else if (f.kind === 1 && f.parens === 0) close();
        else {
          if (f.kind === 1) f.parens--;
          word(f, i).text += ")";
        }
        i++;
        break;
      case 59:
        separate(f, ";", i);
        i++;
        break;
      case 38:
        separate(f, "&", i);
        i += text.charCodeAt(i + 1) === 38 ? 2 : 1;
        break;
      case 124: {
        const nx = text.charCodeAt(i + 1);
        separate(f, nx === 124 ? "||" : "|", i);
        i += nx === 124 || nx === 38 ? 2 : 1;
        break;
      }
      case 60:
      case 62: {
        if (text.charCodeAt(i + 1) === 40 && stack.length < MAX_FRAMES) {
          open(1, c === 62);
          i += 2;
          break;
        }
        endWord(f);
        let j = i + 1;
        while (j < n && j < i + 3 && text.charCodeAt(j) === c) j++;
        f.redir = { op: text.slice(i, j), target: null };
        if (!f.cmd) {
          f.cmd = { start: i, pipeStart: f.inPipe ? f.pipeStart : i, words: [], redirs: [], carry: f.inPipe && f.carry };
          f.pipeStart = f.cmd.pipeStart;
        }
        f.cmd.redirs.push(f.redir);
        i = j;
        break;
      }
      default: {
        let j = i + 1;
        for (; j < n; j++) {
          const d = text.charCodeAt(j);
          if (d < 128 && PLAIN_STOP[d] === 1) break;
        }
        word(f, i).text += text.slice(i, j);
        i = j;
      }
    }
  }
  while (stack.length > 1) close();
  separate(stack[0]!, "end", n);
  return hits;
}

const PLAIN_STOP = new Uint8Array(128);
for (const ch of " \t\r\n\f\v\\'\"$`();&|<>") PLAIN_STOP[ch.charCodeAt(0)] = 1;

/**
 * Prose is not a command: outside fences, each inline code span becomes a line of its own and the
 * sentence around it a different one, so a span is never read as a substitution inside its sentence.
 * The result has the same length as the text.
 */
function splitInlineCode(text: string): string {
  const parts: string[] = [];
  let fenced = false;
  for (let from = 0; from <= text.length; ) {
    let to = text.indexOf("\n", from);
    if (to < 0) to = text.length;
    const line = text.slice(from, to);
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      parts.push(line);
    } else parts.push(fenced || line.indexOf("`") < 0 ? line : spans(line));
    from = to + 1;
  }
  return parts.join("\n");
}

function spans(line: string): string {
  const runs: { at: number; len: number; next: number }[] = [];
  for (let i = 0; i < line.length; ) {
    if (line.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line.charCodeAt(j) === 96) j++;
    runs.push({ at: i, len: j - i, next: -1 });
    i = j;
  }
  const last = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    runs[r]!.next = last.get(runs[r]!.len) ?? -1;
    last.set(runs[r]!.len, r);
  }
  const chars = line.split("");
  for (let r = 0; r < runs.length; r++) {
    const close = runs[r]!.next;
    if (close < 0) continue;
    for (const k of [r, close]) for (let c = 0; c < runs[k]!.len; c++) chars[runs[k]!.at + c] = "\n";
    r = close;
  }
  return chars.join("");
}

// A document with none of these cannot hold a hit, so the scanner never runs on it.
const ANCHOR = /\.(?:ssh|aws|npmrc|netrc|gnupg|env)(?![\w-])|\bid_(?:rsa|ed25519|ecdsa|dsa)|\b(?:env|printenv)\b/i;

/**
 * Commands that send a credential file or the whole environment somewhere. A secret variable is not a hit:
 * it travels to the service it belongs to in ordinary use, and no check can tell where. Runs over the masked
 * text of every file and every fence: a code sample that does this is the attack, not an example.
 */
export function uploadFindings(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    if (!ANCHOR.test(d.safe)) continue;
    for (const h of scanText(isProse(d.file) ? splitInlineCode(d.safe) : d.safe, 0)) {
      out.push(make("text.credential-upload", { file: d.file, line: d.lineAt(h.start), quote: excerpt(d.safe, h.start, Math.min(h.end - h.start, 300)), hint: "This command sends a credential file or the whole environment to a network destination. Remove it." }));
    }
  }
  return out;
}
