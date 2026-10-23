import { describe, expect, it } from "vitest";
import { renderMarkdown, safeHref } from "../src/markdown";

describe("renderMarkdown (REQ-DELIV-012, IT-PAGE-004)", () => {
  const hostile = [
    "# Title",
    "",
    "<script>alert(1)</script>",
    "",
    `<p onclick="x()">click</p>`,
    "",
    `<iframe src="https://evil.example"></iframe>`,
    "",
    "[bad](javascript:alert(1)) and [tab](java\tscript:alert(1)) and [good](https://example.com/a?b=1&c=2)",
    "",
    "![pixel](https://tracker.example/p.gif)",
  ].join("\n");
  const html = renderMarkdown(hostile);

  it("keeps none of the script, handler, iframe or javascript link", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<img/i);
  });

  it("marks outbound links nofollow ugc and escapes the href", () => {
    expect(html).toContain(`<a href="https://example.com/a?b=1&amp;c=2" rel="nofollow ugc">good</a>`);
  });

  it("shifts headings below the page's own h1", () => {
    expect(html).toContain("<h2>Title</h2>");
  });

  it("only emits allowlisted tags", () => {
    const allowed = new Set(["h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "hr", "br", "a"]);
    const sample = renderMarkdown("# a\n\n## b\n\n- x *y* **z** `c`\n\n1. one\n\n> q\n\n```\n<b>raw</b>\n```\n\n---\n\n[l](/rel) [f](#frag)");
    for (const m of sample.matchAll(/<\/?([a-z0-9]+)/g)) expect(allowed.has(m[1] ?? "")).toBe(true);
  });

  it("shows code as escaped text, never markup", () => {
    expect(renderMarkdown("```html\n<script>alert(1)</script>\n```")).toBe("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>");
    expect(renderMarkdown("use `<b>` here")).toContain("<code>&lt;b&gt;</code>");
  });

  it("cannot be broken out of a link by quotes", () => {
    const out = renderMarkdown(`[x](https://a.example/"onmouseover="alert(1))`);
    expect(out).not.toMatch(/"onmouseover=/);
  });

  it("renders lists, quotes and emphasis", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("> hi")).toBe("<blockquote><p>hi</p></blockquote>");
    expect(renderMarkdown("**b** and *i*")).toBe("<p><strong>b</strong> and <em>i</em></p>");
  });
});

describe("safeHref", () => {
  it.each(["javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x", "vbscript:x", "java\nscript:x", " javascript:x", "file:///etc/passwd", ""])("refuses %j", (u) => {
    expect(safeHref(u)).toBeNull();
  });
  it.each(["https://a.example", "http://a.example", "mailto:a@b.example", "/x", "../x", "#top", "x/y"])("accepts %j", (u) => {
    expect(safeHref(u)).not.toBeNull();
  });
});
