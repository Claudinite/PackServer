import { stripBom, type TextFile } from "../engine/files.ts";

/**
 * A scannable string: a whole file, or the strings of a JSON file joined by newlines. Rules run one
 * global regex over `text` and ask the document where an offset is, so work stays linear in size.
 */
export interface Doc {
  file: string;
  text: string;
  /** Same length as `text`, with detected secrets and secret-looking URL parameters masked. */
  safe: string;
  /** `safe` with closed code-language fences of a Markdown file blanked out. */
  prose: string;
  json: boolean;
  lineAt(offset: number): number | null;
  /** For pack.json, the top-level key the string sits under. */
  fieldAt(offset: number): string | null;
}

const SECRET_SOURCES: readonly { kind: string; source: string; flags?: string }[] = [
  { kind: "GitHub token", source: "\\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\\b" },
  { kind: "AWS access key id", source: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b" },
  { kind: "Anthropic API key", source: "\\bsk-ant-[A-Za-z0-9_-]{20,200}" },
  { kind: "API key", source: "\\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,200}" },
  { kind: "Slack token", source: "\\bxox[abprs]-[A-Za-z0-9-]{10,200}" },
  { kind: "Google API key", source: "\\bAIza[0-9A-Za-z_-]{35}\\b" },
  { kind: "Stripe key", source: "\\b[sr]k_live_[0-9A-Za-z]{20,200}" },
  { kind: "npm token", source: "\\bnpm_[A-Za-z0-9]{36}\\b" },
  { kind: "private key", source: "-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----" },
  { kind: "Cloudflare API token", source: "\\b(?:cf|cloudflare)[_-]?(?:api[_-]?)?token\\s{0,8}[:=]\\s{0,8}[\"']?[A-Za-z0-9_-]{40}\\b", flags: "i" },
];

export const SECRET_PATTERNS = SECRET_SOURCES.map((s) => ({ kind: s.kind, flags: "g" + (s.flags ?? ""), source: s.source }));

const SECRET_QUERY = /([?&;][\w.-]{0,40}(?:token|key|secret|passw|auth|sig|credential|session)[\w.-]{0,40}=)([^&\s"'<>#]{1,300})/gi;
const URL_USERINFO = /(\bhttps?:\/\/[^\s/:@]{1,100}:)([^\s/@]{1,200})(@)/gi;
const QUICK = /gh[pousr]_|github_pat_|AKIA|ASIA|sk-|xox|AIza|_live_|npm_|PRIVATE KEY|oken|[?&;]|:\/\/|(?:cf|cloudflare)/i;

const stars = (m: string) => "*".repeat(m.length);

/** Same-length copy with secrets and secret-looking URL parameters replaced by asterisks. */
export function maskSecrets(text: string): string {
  if (!QUICK.test(text)) return text;
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(new RegExp(p.source, p.flags), stars);
  out = out.replace(SECRET_QUERY, (_m, a: string, v: string) => a + stars(v));
  out = out.replace(URL_USERINFO, (_m, a: string, v: string, c: string) => a + stars(v) + c);
  return out;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function floorIndex(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sorted[mid]! <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Fences named for a programming or shell language hold code samples; any other fence is text an agent reads.
const CODE_LANGUAGES = new Set([
  "js", "javascript", "jsx", "mjs", "cjs", "ts", "typescript", "tsx", "python", "py", "sh", "shell", "bash", "zsh", "fish",
  "powershell", "ps1", "go", "golang", "rust", "rs", "java", "kotlin", "c", "cpp", "csharp", "cs", "ruby", "rb", "php", "swift",
  "sql", "json", "jsonc", "yaml", "yml", "toml", "html", "css", "diff", "dockerfile", "console",
]);

/** Blanks closed fences of a code language; an unclosed fence, or one with no or another language, stays visible. */
function blankFences(text: string, starts: readonly number[]): string {
  const blank = new Array<boolean>(starts.length).fill(false);
  let open: { marker: string; line: number; code: boolean } | null = null;
  const lineAt = (i: number) => text.slice(starts[i]!, i + 1 < starts.length ? starts[i + 1]! - 1 : text.length);
  for (let i = 0; i < starts.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.{0,200})/.exec(lineAt(i));
    if (!m) continue;
    const marker = m[1]!;
    if (!open) {
      const lang = m[2]!.trim().split(/[\s{,]/)[0]!.toLowerCase();
      open = { marker, line: i, code: CODE_LANGUAGES.has(lang) };
    } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[2]!.trim() === "") {
      if (open.code) for (let k = open.line; k <= i; k++) blank[k] = true;
      open = null;
    }
  }
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const line = lineAt(i);
    parts.push(blank[i] ? " ".repeat(line.length) : line);
  }
  return parts.join("\n");
}

const isMarkdown = (file: string) => /\.(md|markdown)$/i.test(file);

export function rawDoc(file: string, text: string): Doc {
  const starts = lineStartsOf(text);
  const safe = maskSecrets(text);
  return {
    file,
    text,
    safe,
    prose: isMarkdown(file) ? blankFences(safe, starts) : safe,
    json: false,
    lineAt: (o) => floorIndex(starts, o) + 1,
    fieldAt: () => null,
  };
}

interface Segment {
  start: number;
  line: number;
  field: string | null;
}

/** Strings of a JSON text with the line each starts on; null when it is not JSON or is nested absurdly deep. */
function jsonStrings(raw: string): { text: string; line: number; field: string | null }[] | null {
  const out: { text: string; line: number; field: string | null }[] = [];
  let i = 0;
  let line = 1;
  const n = raw.length;

  const skip = () => {
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (c === 10) line++;
      else if (c !== 32 && c !== 9 && c !== 13) break;
      i++;
    }
  };
  const readString = (): string => {
    const start = i;
    i++;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (c === 92) i += 2;
      else if (c === 34) break;
      else if (c < 32) throw new Error("control character in string");
      else i++;
    }
    if (i >= n) throw new Error("unterminated string");
    i++;
    return JSON.parse(raw.slice(start, i)) as string;
  };
  const value = (depth: number, field: string | null): void => {
    if (depth > 200) throw new Error("too deep");
    skip();
    const c = raw[i];
    if (c === '"') {
      const startLine = line;
      out.push({ text: readString(), line: startLine, field });
    } else if (c === "{") {
      i++;
      skip();
      if (raw[i] === "}") return void i++;
      for (;;) {
        skip();
        if (raw[i] !== '"') throw new Error("key expected");
        const startLine = line;
        const key = readString();
        const keyField = depth === 0 ? key : field;
        out.push({ text: key, line: startLine, field: keyField });
        skip();
        if (raw[i++] !== ":") throw new Error("colon expected");
        value(depth + 1, keyField);
        skip();
        const d = raw[i++];
        if (d === "}") return;
        if (d !== ",") throw new Error("comma expected");
      }
    } else if (c === "[") {
      i++;
      skip();
      if (raw[i] === "]") return void i++;
      for (;;) {
        value(depth + 1, field);
        skip();
        const d = raw[i++];
        if (d === "]") return;
        if (d !== ",") throw new Error("comma expected");
      }
    } else {
      const m = /^(?:-?\d[\d.eE+-]{0,400}|true|false|null)/.exec(raw.slice(i, i + 410));
      if (!m) throw new Error("bad value");
      i += m[0].length;
    }
  };
  try {
    value(0, null);
    skip();
    if (i < n) return null;
  } catch {
    return null;
  }
  return out;
}

export function jsonDoc(file: string, raw: string): Doc | null {
  const strings = jsonStrings(stripBom(raw));
  if (!strings) return null;
  const segments: Segment[] = [];
  const starts: number[] = [];
  let pos = 0;
  const pieces: string[] = [];
  for (const s of strings) {
    segments.push({ start: pos, line: s.line, field: s.field });
    starts.push(pos);
    pieces.push(s.text);
    pos += s.text.length + 1;
  }
  const text = pieces.join("\n");
  const safe = maskSecrets(text);
  const at = (o: number) => (starts.length ? segments[floorIndex(starts, o)]! : null);
  return { file, text, safe, prose: safe, json: true, lineAt: (o) => at(o)?.line ?? null, fieldAt: (o) => at(o)?.field ?? null };
}

/** Documents the content rules read: a JSON file by its decoded strings, anything else as written. */
export function contentDocs(files: readonly TextFile[]): Doc[] {
  return files.map((f) => (f.path.endsWith(".json") ? jsonDoc(f.path, f.text) : null) ?? rawDoc(f.path, f.text));
}

/** Documents of the files exactly as written. */
export function rawDocs(files: readonly TextFile[]): Doc[] {
  return files.map((f) => rawDoc(f.path, f.text));
}

export const isProse = (file: string): boolean => /\.(md|markdown|txt|json)$/i.test(file);
export const isCode = (file: string): boolean => /\.(go|mjs|cjs|js|ts|sh|bash|zsh|py|ps1)$/i.test(file) || /^checks\//.test(file);

/** Every match of a global regex, in order. */
export function* matchesOf(re: RegExp, text: string): Generator<RegExpExecArray> {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let m = g.exec(text); m; m = g.exec(text)) {
    yield m;
    if (m[0].length === 0) g.lastIndex++;
  }
}
