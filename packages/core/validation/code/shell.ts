import { excerpt } from "../engine/rules.ts";
import type { Emit, Source } from "./rules.ts";

interface Word {
  text: string;
  /** Holds an expansion (`$x`, `${x}`, backticks), so what it names is not known. */
  dynamic: boolean;
  /** Written entirely inside single quotes, or as plain characters: its value is what it says. */
  literal: boolean;
}

type Command = Word[];

const SEPARATORS = new Set([";", "&", "|", "(", ")", "{", "}", "\n"]);

/** Splits one logical line into simple commands of words, with quotes and backslashes resolved. */
function parse(line: string): Command[] {
  const commands: Command[] = [];
  let cur: Command = [];
  let word: Word | null = null;
  const flushWord = () => {
    if (word) cur.push(word);
    word = null;
  };
  const flushCommand = () => {
    flushWord();
    if (cur.length) commands.push(cur);
    cur = [];
  };
  const add = (c: string, dynamic = false, literal = true) => {
    word ??= { text: "", dynamic: false, literal: true };
    word.text += c;
    if (dynamic) word.dynamic = true;
    if (!literal) word.literal = false;
  };
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i]!;
    if (c === "\\") {
      add(line[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      word ??= { text: "", dynamic: false, literal: true };
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      word.text += line.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      word ??= { text: "", dynamic: false, literal: true };
      i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === "\\") {
          add(line[i + 1] ?? "");
          i += 2;
        } else if (line[i] === "$" && line[i + 1] === "(") {
          // A command substitution inside quotes starts a command of its own.
          flushCommand();
          i += 2;
        } else if (line[i] === "`") {
          flushCommand();
          i++;
        } else if (line[i] === "$") {
          add("$", true, false);
          i++;
        } else add(line[i++]!);
      }
      i++;
    } else if (c === "$" && line[i + 1] === "(") {
      flushCommand();
      i += 2;
    } else if (c === "`") {
      flushCommand();
      i++;
    } else if ((c === "<" || c === ">") && line[i + 1] === "(") {
      add(c, true, false);
      i++;
    } else if (c === "$") {
      add("$", true, false);
      i++;
    } else if (c === "#" && !word) {
      break;
    } else if (c === " " || c === "\t" || c === "\r") {
      flushWord();
      i++;
    } else if (SEPARATORS.has(c)) {
      flushCommand();
      i++;
    } else {
      add(c);
      i++;
    }
  }
  flushCommand();
  return commands;
}

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "xargs", "nice", "ionice", "timeout", "busybox", "stdbuf", "setsid", "then", "do", "else", "elif", "if", "while", "until", "!", "&&", "||"]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "scp", "sftp", "ftp", "tftp", "rsync", "dig", "nslookup", "host", "gh", "apt", "apt-get", "apk", "brew", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "pipx", "gem", "cargo", "bun", "bunx", "deno", "dnf", "yum", "zypper"]);
const GIT_NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule", "remote"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
const INTERPRETERS: Record<string, string> = { python: "-c", python2: "-c", python3: "-c", node: "-e", nodejs: "-e", deno: "eval", bun: "-e", perl: "-e", ruby: "-e", php: "-r", lua: "-e", pwsh: "-c", powershell: "-c" };

const SHELL_BASE64 = /(?:^|[\s;&|(`$])(?:base64\s+(?:-\w+\s+)*(?:-d|--decode|-D)\b|openssl\s+(?:enc|base64)\b[^\n]{0,40}-d\b)/;
const DEV_TCP = /\/dev\/(?:tcp|udp)\//;

function givesProgram(arg: string, flag: string): boolean {
  if (arg === flag) return true;
  return flag.startsWith("-") && /^-[a-zA-Z]+$/.test(arg) && arg.includes(flag.slice(1));
}

function endsInBackslash(line: string): boolean {
  let k = line.length;
  while (k > 0 && line[k - 1] === "\\") k--;
  return (line.length - k) % 2 === 1;
}

function commandWord(words: Command): { index: number; name: string; dynamic: boolean } | null {
  let k = 0;
  while (k < words.length) {
    const w = words[k]!;
    const base = w.text.slice(w.text.lastIndexOf("/") + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) k++;
    else if (WRAPPERS.has(base) && !w.dynamic) {
      k++;
      while (k < words.length && (/^-/.test(words[k]!.text) || /^\d+$/.test(words[k]!.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!.text))) k++;
    } else return { index: k, name: base, dynamic: w.dynamic };
  }
  return null;
}

function analyse(words: Command, line: number, src: Source, emit: Emit, depth: number): void {
  const cmd = commandWord(words);
  if (!cmd) return;
  const where = (rule: string, hint: string) => emit(rule, { file: src.file, line, quote: excerpt(words.map((w) => w.text).join(" "), 0, 80), hint });
  const args = words.slice(cmd.index + 1);
  if (cmd.dynamic) {
    where("code.dynamic-access", "A command named by a variable cannot be checked against the network and eval rules. Write the command out.");
    return;
  }
  const name = cmd.name.toLowerCase();
  if (NETWORK_COMMANDS.has(name)) where("code.network", "Checks, guards, task workers and env setup may not open network connections, and there is no exception to declare.");
  else if (name === "git" && args.some((a) => GIT_NETWORK.has(a.text))) where("code.network", "Checks, guards, task workers and env setup may not open network connections, and there is no exception to declare.");
  else if (name === "go" && /^(?:get|install)$/.test(args[0]?.text ?? "")) where("code.network", "Checks, guards, task workers and env setup may not open network connections, and there is no exception to declare.");
  else if (name === "eval") where("code.eval", "Code that builds or loads other code at run time cannot be read in advance. Write the logic out.");
  else if (name === "source" || name === ".") {
    if (args.some((a) => a.dynamic) || args.length === 0) where("code.eval", "Sourcing a computed file cannot be read in advance.");
  } else if (SHELLS.has(name)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.text));
    if (c !== -1) {
      const arg = args[c + 1];
      if (!arg || arg.dynamic || !arg.literal) where("code.eval", "A shell given a computed command string cannot be read in advance.");
      else if (depth < 3) for (const inner of parse(arg.text)) analyse(inner, line, src, emit, depth + 1);
    }
  } else if (INTERPRETERS[name] && args.some((a) => givesProgram(a.text, INTERPRETERS[name]!))) {
    where("code.eval", "An interpreter given its program on the command line hides the program from review. Put it in a file.");
  }
}

export function shellRules(src: Source, emit: Emit): void {
  // Continuation lines join, and each logical line keeps the number of its first physical line.
  const physical = src.text.split("\n");
  for (let k = 0; k < physical.length; k++) {
    const start = k + 1;
    const parts = [physical[k]!];
    let size = parts[0]!.length;
    while (endsInBackslash(parts[parts.length - 1]!) && k + 1 < physical.length && size < 100_000) {
      parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, -1);
      parts.push(physical[++k]!);
      size += parts[parts.length - 1]!.length;
    }
    const line = parts.join(" ");
    if (DEV_TCP.test(line)) emit("code.network", { file: src.file, line: start, quote: excerpt(line, 0, line.length), hint: "Checks, guards, task workers and env setup may not open network connections, and there is no exception to declare." });
    if (SHELL_BASE64.test(line)) emit("code.base64", { file: src.file, line: start, quote: excerpt(line, 0, line.length), hint: "Decoding base64 in a script can hide what it runs. Keep readable text readable." });
    for (const words of parse(line)) analyse(words, start, src, emit, 0);
  }
}
