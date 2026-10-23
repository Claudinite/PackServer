/**
 * README rendering (REQ-DELIV-012). The output is built only from the tags below, so the safety
 * does not depend on filtering a parsed tree: raw HTML in the source is dropped, every text run
 * is escaped, and a link target must pass the scheme allowlist or the link becomes plain text.
 *
 * Allowed output tags: h2-h6, p, ul, ol, li, blockquote, pre, code, em, strong, hr, br, a.
 * Images are not rendered; an image is shown as a link to it.
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

function anchor(text: string, rawUrl: string): string {
  const target = safeHref(rawUrl);
  if (!target) return text;
  const rel = target.external || !target.href.startsWith("#") ? ` rel="nofollow ugc"` : "";
  return `<a href="${escapeHtml(target.href)}"${rel}>${text}</a>`;
}

function inline(source: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `\uE000${stash.push(html) - 1}\uE000`;
  let s = source.replace(/\uE000/g, "");
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  s = s.replace(/<(https?:\/\/[^>\s]+)>/gi, (_m, url: string) => keep(anchor(escapeHtml(url), url)));
  s = s.replace(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>?/g, "");
  s = s.replace(/!?\[([^\]\n]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g, (m, text: string, url: string) => {
    const label = text === "" ? url : text;
    return keep(anchor(inlineEmphasis(escapeHtml(label)), url.replace(/^<|>$/g, "")));
  });
  s = inlineEmphasis(escapeHtml(s));
  return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => stash[Number(i)] ?? "");
}

function inlineEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)|(^|[^_\w])_([^_\n]+)_(?!\w)/g, (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) => `${p1 ?? p2 ?? ""}<em>${a ?? b}</em>`);
}

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
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
    const heading = HEADING.exec(line);
    if (heading) {
      // The page owns the only h1.
      const level = Math.min(6, (heading[1]?.length ?? 1) + 1);
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) quoted.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
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
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || FENCE.test(l.trim()) || HEADING.test(l) || RULE.test(l) || l.startsWith(">") || BULLET.test(l) || ORDERED.test(l)) break;
      para.push(l.trim());
      i++;
    }
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, " ")}</p>`);
  }
  return out.join("\n");
}
