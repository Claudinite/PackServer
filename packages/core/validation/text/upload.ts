import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { type Doc } from "./doc.ts";

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

const WRAPPERS = new Set(["sudo", "doas", "time", "nohup", "command", "exec", "nice", "env"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);
const HTTP = new Set(["curl", "wget"]);
const STREAM = new Set(["nc", "ncat", "netcat", "socat", "telnet", "ssh"]);
const COPY = new Set(["scp", "rsync", "sftp"]);
const POWERSHELL = new Set(["invoke-webrequest", "invoke-restmethod", "iwr", "irm"]);
const READERS = new Set(["cat", "tac", "head", "tail", "less", "more", "strings", "base64", "xxd", "od", "hexdump", "gzip", "zcat", "bzip2", "xz", "tar", "zip", "openssl", "dd", "get-content", "gc", "type"]);

const CURL_VALUE_LETTERS = "HouAeXxwbcDKmEyYzCrtPQ";
const CURL_PAYLOAD_LETTERS = "dFT";
const CURL_PAYLOAD_LONG = new Set(["data", "data-ascii", "data-binary", "data-raw", "data-urlencode", "form", "form-string", "upload-file", "json", "post-file", "post-data", "body-file", "body-data"]);
const SCP_VALUE_FLAGS = new Set(["-c", "-D", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-X", "-R", "-b", "-s"]);
const RSYNC_VALUE_FLAGS = new Set(["-e", "-f", "-B", "-T", "--rsh", "--exclude", "--include", "--filter", "--exclude-from", "--include-from", "--files-from", "--rsync-path", "--log-file", "--password-file", "--temp-dir", "--partial-dir"]);

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

const credWord = (w: Word): boolean => w.sub || credFile(w.text);
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
  if (args.some((a) => a.sub)) return true;
  let stdinFlag = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    const t = a.text;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if (!CURL_PAYLOAD_LONG.has(name)) continue;
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
  const valueFlags = name === "rsync" ? RSYNC_VALUE_FLAGS : SCP_VALUE_FLAGS;
  const ops: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (isFlag(a)) {
      if (valueFlags.has(a.text)) k++;
      continue;
    }
    ops.push(a);
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
    if (/^[A-Za-z_]\w*=/.test(t)) {
      k++;
      continue;
    }
    if (WRAPPERS.has(baseName(t))) {
      envOnly = baseName(t) === "env";
      k++;
      while (k < w.length && isFlag(w[k]!)) k++;
      continue;
    }
    envOnly = false;
    break;
  }
  const dump = k >= w.length && envOnly;
  const name = k < w.length ? baseName(w[k]!.text) : dump ? "env" : "";
  const args = k < w.length ? w.slice(k + 1) : [];
  const redirected = cmd.redirs.some((r) => r.op.charCodeAt(0) === 60 && r.target !== null && credWord(r.target));
  const stdinTainted = cmd.carry || redirected;
  const stream = HTTP.has(name) || STREAM.has(name) || POWERSHELL.has(name) || COPY.has(name);

  let hit = false;
  if (HTTP.has(name)) hit = httpVerdict(args, stdinTainted, name === "wget");
  else if (STREAM.has(name)) hit = stdinTainted || args.some((a) => a.sub) || (name === "socat" && args.some((a) => !isFlag(a) && credFile(a.text)));
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
      w.some((x) => x.sub) ||
      (READERS.has(name) && args.some((a) => !isFlag(a) && credFile(a.text))));
  return { tainted, hit };
}

function scanText(text: string, depth: number): Hit[] {
  const hits: Hit[] = [];
  const n = text.length;
  const newFrame = (kind: 0 | 1 | 2): Frame => ({ kind, parens: 0, quote: 0, cur: null, redir: null, cmd: null, inPipe: false, carry: false, pipeStart: 0, last: false });
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
      const v = analyze(f.cmd, depth);
      if (v.hit && hits.length < MAX_HITS) hits.push({ start: f.cmd.pipeStart, end });
      f.last = v.tainted;
      f.carry = v.tainted;
      f.inPipe = kind === "|";
      f.cmd = null;
    } else if (kind !== "\n") {
      f.inPipe = false;
      f.carry = false;
    }
  };
  const close = (): void => {
    const f = stack.pop()!;
    separate(f, "end", i);
    word(stack[stack.length - 1]!, i).sub ||= f.last;
  };
  const open = (kind: 1 | 2): void => {
    word(stack[stack.length - 1]!, i);
    stack.push(newFrame(kind));
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
        if (f.kind === 1) f.parens++;
        word(f, i).text += "(";
        i++;
        break;
      case 41:
        if (f.kind === 1 && f.parens === 0) close();
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
    for (const h of scanText(d.safe, 0)) {
      out.push(make("text.credential-upload", { file: d.file, line: d.lineAt(h.start), quote: excerpt(d.safe, h.start, Math.min(h.end - h.start, 300)), hint: "This command sends a credential file or the whole environment to a network destination. Remove it." }));
    }
  }
  return out;
}
