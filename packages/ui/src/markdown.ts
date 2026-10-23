/**
 * README rendering (REQ-DELIV-012). The output is built only from the tags below, so the safety
 * does not depend on filtering a parsed tree: raw HTML in the source is dropped, every text run
 * is escaped, and a link target must pass the scheme allowlist or the link becomes plain text.
 *
 * Allowed output tags: h2-h6, p, ul, ol, li, blockquote, pre, code, em, strong, hr, a.
 * Images are not rendered; an image is shown as a link to it.
 *
 * READMEs are hostile input rendered at publish time, so no scan here may be superlinear: there
 * are no backtracking patterns over input, and every search for a closing delimiter is a binary
 * search over positions found in one pass.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Absolute http(s) and mailto only; relative and fragment targets pass, any other scheme does not. */
export function safeHref(raw: string): { href: string; external: boolean } | null {
  const url = raw.trim();
  // eslint-disable-next-line no-control-regex -- control characters inside a scheme are how `java\tscript:` evades a check
  if (url === "" || /[\x00-\x20\x7f-\x9f]/.test(url)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined) return { href: url, external: url.startsWith("//") };
  if (scheme === "http" || scheme === "https") return { href: url, external: true };
  if (scheme === "mailto") return { href: url, external: true };
  return null;
}

function anchor(textHtml: string, rawUrl: string): string {
  const target = safeHref(rawUrl);
  if (!target) return textHtml;
  const rel = target.href.startsWith("#") ? "" : ` rel="nofollow ugc"`;
  return `<a href="${escapeHtml(target.href)}"${rel}>${textHtml}</a>`;
}

type Refs = ReadonlyMap<string, string>;

const MAX_LABEL = 200;

function normalizeLabel(label: string): string | null {
  if (label.length > MAX_LABEL) return null;
  const key = label.trim().replace(/\s+/g, " ").toLowerCase();
  return key === "" ? null : key;
}

/** Sorted offsets, so "the next one at or after x" is a binary search wherever the scan is. */
class Offsets {
  constructor(private readonly at: readonly number[]) {}
  next(from: number): number {
    let lo = 0;
    let hi = this.at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.at[mid] ?? 0) < from) lo = mid + 1;
      else hi = mid;
    }
    return this.at[lo] ?? -1;
  }
}

const isSpaceCode = (c: number) => c <= 32;
const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAsciiPunct = (c: number) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);

const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/y;

// \\ ` [ ! < & * _ newline > " '
const SPECIAL = new Uint8Array(128);
for (const ch of "\\`[!<&*_\n>\"'") SPECIAL[ch.charCodeAt(0)] = 1;

interface Opener {
  ch: number;
  len: number;
  /** Index in the output of the marker text still unmatched, and of the slot that collects its tags. */
  lit: number;
  tag: number;
}

class InlineParser {
  private memo: { gt?: Offsets; ws?: Offsets; comment?: Offsets; dq?: Offsets; sq?: Offsets; ticks?: Map<number, Offsets>; brackets?: Int32Array } = {};

  constructor(private readonly src: string, private readonly refs: Refs) {}

  private offsetsOf(test: (c: number) => boolean): Offsets {
    const at: number[] = [];
    for (let i = 0; i < this.src.length; i++) if (test(this.src.charCodeAt(i))) at.push(i);
    return new Offsets(at);
  }
  private get gt() { return (this.memo.gt ??= this.offsetsOf((c) => c === 62)); }
  private get ws() { return (this.memo.ws ??= this.offsetsOf(isSpaceCode)); }
  private get dq() { return (this.memo.dq ??= this.offsetsOf((c) => c === 34)); }
  private get sq() { return (this.memo.sq ??= this.offsetsOf((c) => c === 39)); }
  private get comment() {
    if (!this.memo.comment) {
      const at: number[] = [];
      for (let i = this.src.indexOf("-->"); i !== -1; i = this.src.indexOf("-->", i + 1)) at.push(i);
      this.memo.comment = new Offsets(at);
    }
    return this.memo.comment;
  }
  private get ticks() {
    if (!this.memo.ticks) {
      const runs = new Map<number, number[]>();
      const s = this.src;
      for (let i = 0; i < s.length; ) {
        if (s.charCodeAt(i) !== 96) { i++; continue; }
        let j = i;
        while (j < s.length && s.charCodeAt(j) === 96) j++;
        const starts = runs.get(j - i) ?? [];
        starts.push(i);
        runs.set(j - i, starts);
        i = j;
      }
      this.memo.ticks = new Map([...runs].map(([len, starts]) => [len, new Offsets(starts)]));
    }
    return this.memo.ticks;
  }
  /** For each `[`, the offset of its matching `]` (or -1). */
  private get brackets() {
    if (!this.memo.brackets) {
      const s = this.src;
      const match = new Int32Array(s.length).fill(-1);
      const stack: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 92) i++;
        else if (c === 91) stack.push(i);
        else if (c === 93) {
          const open = stack.pop();
          if (open !== undefined) match[open] = i;
        }
      }
      this.memo.brackets = match;
    }
    return this.memo.brackets;
  }

  /** `(dest "title")` starting after the `(`; returns the destination and the offset past the `)`. */
  private inlineDestination(from: number, end: number): { url: string; after: number } | null {
    const s = this.src;
    let p = from;
    while (p < end && isSpaceCode(s.charCodeAt(p))) p++;
    let url: string;
    let q: number;
    if (s.charCodeAt(p) === 60) {
      const close = this.gt.next(p + 1);
      const space = this.ws.next(p + 1);
      if (close === -1 || close >= end || (space !== -1 && space < close)) return null;
      url = s.slice(p + 1, close);
      q = close + 1;
    } else {
      let depth = 0;
      q = p;
      for (; q < end; q++) {
        const c = s.charCodeAt(q);
        if (isSpaceCode(c)) break;
        // A bracket in a destination ends the attempt, which keeps every attempt's scan disjoint.
        if (c === 91 || c === 93) return null;
        if (c === 40) depth++;
        else if (c === 41) {
          if (depth === 0) break;
          depth--;
        }
      }
      url = s.slice(p, q);
      if (url === "") return null;
    }
    while (q < end && isSpaceCode(s.charCodeAt(q))) q++;
    const quote = s.charCodeAt(q);
    if (q < end && (quote === 34 || quote === 39)) {
      const close = (quote === 34 ? this.dq : this.sq).next(q + 1);
      if (close === -1 || close >= end) return null;
      q = close + 1;
      while (q < end && isSpaceCode(s.charCodeAt(q))) q++;
    }
    if (q >= end || s.charCodeAt(q) !== 41) return null;
    return { url, after: q + 1 };
  }

  private tryLink(open: number, end: number): { html: string; after: number } | null {
    const s = this.src;
    const close = this.brackets[open] ?? -1;
    if (close < 0 || close >= end) return null;
    let url: string | undefined;
    let after = close + 1;
    if (s.charCodeAt(close + 1) === 40 && close + 1 < end) {
      const dest = this.inlineDestination(close + 2, end);
      if (dest) {
        url = dest.url;
        after = dest.after;
      }
    } else if (this.refs.size > 0) {
      let label: string | null = null;
      if (s.charCodeAt(close + 1) === 91 && close + 1 < end) {
        const refClose = this.brackets[close + 1] ?? -1;
        if (refClose >= 0 && refClose < end) {
          label = refClose === close + 2 ? s.slice(open + 1, Math.min(close, open + 1 + MAX_LABEL + 1)) : s.slice(close + 2, Math.min(refClose, close + 2 + MAX_LABEL + 1));
          after = refClose + 1;
        }
      } else {
        label = s.slice(open + 1, Math.min(close, open + 1 + MAX_LABEL + 1));
      }
      const key = label === null ? null : normalizeLabel(label);
      url = key === null ? undefined : this.refs.get(key);
    }
    if (url === undefined) return null;
    const text = this.parse(open + 1, close, true);
    return { html: anchor(text === "" ? escapeHtml(url) : text, url), after };
  }

  parse(start: number, end: number, inLink: boolean): string {
    const s = this.src;
    const out: string[] = [];
    const stack: Opener[] = [];
    const open = new Map<number, number>();
    let buf = "";
    const flush = () => {
      if (buf !== "") out.push(buf);
      buf = "";
    };
    let i = start;
    while (i < end) {
      const c = s.charCodeAt(i);
      if (c < 128 && SPECIAL[c] !== 1) {
        let j = i + 1;
        while (j < end) {
          const d = s.charCodeAt(j);
          if (d < 128 && SPECIAL[d] === 1) break;
          j++;
        }
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      if (c >= 128) { buf += s[i]; i++; continue; }
      switch (c) {
        case 10: buf += " "; i++; break;
        case 62: buf += "&gt;"; i++; break;
        case 34: buf += "&quot;"; i++; break;
        case 39: buf += "&#39;"; i++; break;
        case 92: {
          const next = i + 1 < end ? s.charCodeAt(i + 1) : 0;
          if (isAsciiPunct(next)) { buf += escapeHtml(s[i + 1] ?? ""); i += 2; }
          else { buf += "\\"; i++; }
          break;
        }
        case 38: {
          ENTITY.lastIndex = i;
          const m = ENTITY.exec(s);
          if (m && i + m[0].length <= end) { buf += m[0]; i += m[0].length; }
          else { buf += "&amp;"; i++; }
          break;
        }
        case 96: {
          let n = 1;
          while (i + n < end && s.charCodeAt(i + n) === 96) n++;
          const closeAt = this.ticks.get(n)?.next(i + n) ?? -1;
          if (closeAt !== -1 && closeAt + n <= end) {
            flush();
            out.push(`<code>${escapeHtml(s.slice(i + n, closeAt).replace(/\n/g, " ").trim())}</code>`);
            i = closeAt + n;
          } else {
            buf += "`".repeat(n);
            i += n;
          }
          break;
        }
        case 33:
        case 91: {
          const isImage = c === 33;
          if (isImage && s.charCodeAt(i + 1) !== 91) { buf += "!"; i++; break; }
          const link = inLink ? null : this.tryLink(isImage ? i + 1 : i, end);
          if (link) { flush(); out.push(link.html); i = link.after; }
          else if (isImage) { buf += "!"; i++; }
          else { buf += "["; i++; }
          break;
        }
        case 60: {
          const head = s.slice(i + 1, i + 9).toLowerCase();
          if (head.startsWith("http://") || head.startsWith("https://")) {
            const close = this.gt.next(i + 1);
            const space = this.ws.next(i + 1);
            if (close !== -1 && close < end && (space === -1 || close < space)) {
              const url = s.slice(i + 1, close);
              flush();
              out.push(inLink ? escapeHtml(url) : anchor(escapeHtml(url), url));
              i = close + 1;
              break;
            }
          }
          if (s.startsWith("<!--", i)) {
            const close = this.comment.next(i + 2);
            if (close !== -1 && close + 3 <= end) { i = close + 3; break; }
          } else {
            const n = s.charCodeAt(i + 1);
            const n2 = s.charCodeAt(i + 2);
            const letter = (x: number) => (x >= 65 && x <= 90) || (x >= 97 && x <= 122);
            if (letter(n) || (n === 47 && letter(n2)) || n === 33 || n === 63) {
              const close = this.gt.next(i + 1);
              if (close !== -1 && close < end) { i = close + 1; break; }
            }
          }
          buf += "&lt;";
          i++;
          break;
        }
        default: {
          // * and _
          let n = 1;
          while (i + n < end && s.charCodeAt(i + n) === c) n++;
          const prev = i > start ? s.charCodeAt(i - 1) : 32;
          const next = i + n < end ? s.charCodeAt(i + n) : 32;
          let canOpen = !isSpaceCode(next);
          let canClose = !isSpaceCode(prev);
          if (c === 95) {
            canOpen = canOpen && !isAlnum(prev);
            canClose = canClose && !isAlnum(next);
          }
          let remaining = n;
          if (canClose && (open.get(c) ?? 0) > 0) {
            flush();
            while (remaining > 0 && (open.get(c) ?? 0) > 0) {
              let k = stack.length - 1;
              while ((stack[k]?.ch ?? 0) !== c) k--;
              for (let d = stack.length - 1; d > k; d--) open.set(stack[d]?.ch ?? 0, (open.get(stack[d]?.ch ?? 0) ?? 1) - 1);
              stack.length = k + 1;
              const opener = stack[k];
              if (!opener) break;
              const use = Math.min(remaining, opener.len) >= 2 ? 2 : 1;
              opener.len -= use;
              remaining -= use;
              out[opener.lit] = String.fromCharCode(c).repeat(opener.len);
              out[opener.tag] = (use === 2 ? "<strong>" : "<em>") + (out[opener.tag] ?? "");
              out.push(use === 2 ? "</strong>" : "</em>");
              if (opener.len === 0) {
                stack.pop();
                open.set(c, (open.get(c) ?? 1) - 1);
              }
            }
          }
          if (remaining > 0) {
            const marker = String.fromCharCode(c).repeat(remaining);
            if (canOpen) {
              flush();
              stack.push({ ch: c, len: remaining, lit: out.length, tag: out.length + 1 });
              open.set(c, (open.get(c) ?? 0) + 1);
              out.push(marker, "");
            } else buf += marker;
          }
          i += n;
        }
      }
    }
    flush();
    return out.join("");
  }
}

function inline(text: string, refs: Refs): string {
  return new InlineParser(text, refs).parse(0, text.length, false);
}

const FENCE = /^(```|~~~)/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const MAX_QUOTE_DEPTH = 6;

function parseHeading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (level < line.length && line.charCodeAt(level) === 35) level++;
  if (level === 0 || level > 6) return null;
  const sep = line.charCodeAt(level);
  if (sep !== 32 && sep !== 9) return null;
  let text = line.slice(level).trim();
  let e = text.length;
  while (e > 0 && text.charCodeAt(e - 1) === 35) e--;
  if (e < text.length && (e === 0 || isSpaceCode(text.charCodeAt(e - 1)))) text = text.slice(0, e).trim();
  return { level, text };
}

/** `[label]: url "title"` on its own line; the title is ignored. */
function parseDefinition(line: string): { key: string; url: string } | null {
  const t = line.trimStart();
  if (line.length - t.length > 3 || t.charCodeAt(0) !== 91) return null;
  const close = t.indexOf("]:");
  if (close < 2) return null;
  const label = t.slice(1, close);
  if (label.includes("[")) return null;
  const key = normalizeLabel(label);
  const rest = t.slice(close + 2).trim();
  if (key === null || rest === "") return null;
  let url: string;
  if (rest.startsWith("<")) {
    const gt = rest.indexOf(">");
    if (gt === -1) return null;
    url = rest.slice(1, gt);
  } else {
    let e = 0;
    while (e < rest.length && !isSpaceCode(rest.charCodeAt(e))) e++;
    url = rest.slice(0, e);
  }
  return url === "" ? null : { key, url };
}

function renderBlocks(lines: readonly string[], depth: number, refs: Refs): string {
  const quotes = depth < MAX_QUOTE_DEPTH;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") { i++; continue; }
    const fence = FENCE.exec(line.trim());
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```")) code.push(lines[i++] ?? "");
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = parseHeading(line);
    if (heading) {
      // The page owns the only h1.
      const level = Math.min(6, heading.level + 1);
      out.push(`<h${level}>${inline(heading.text, refs)}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (quotes && line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) quoted.push((lines[i++] ?? "").replace(/^>[ \t]?/, ""));
      out.push(`<blockquote>${renderBlocks(quoted, depth + 1, refs)}</blockquote>`);
      continue;
    }
    const list = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : null;
    if (list) {
      const tag = list === BULLET ? "ul" : "ol";
      const items: string[] = [];
      while (i < lines.length) {
        const m = list.exec(lines[i] ?? "");
        if (!m) {
          const cont = lines[i] ?? "";
          if (items.length > 0 && /^\s{2,}\S/.test(cont)) { items[items.length - 1] += ` ${cont.trim()}`; i++; continue; }
          break;
        }
        items.push(m[1] ?? "");
        i++;
      }
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t, refs)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || FENCE.test(l.trim()) || parseHeading(l) || RULE.test(l) || (quotes && l.startsWith(">")) || BULLET.test(l) || ORDERED.test(l)) break;
      para.push(l.trim());
      i++;
    }
    out.push(`<p>${inline(para.join("\n"), refs)}</p>`);
  }
  return out.join("\n");
}

export function renderMarkdown(markdown: string): string {
  const lines: string[] = [];
  const refs = new Map<string, string>();
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    const def = inFence ? null : parseDefinition(line);
    if (def) {
      if (!refs.has(def.key)) refs.set(def.key, def.url);
    } else lines.push(line);
  }
  return renderBlocks(lines, 0, refs);
}
