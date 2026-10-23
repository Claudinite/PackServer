import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

const rel = `rel="nofollow ugc"`;

describe("nested constructs resolve (no placeholder leaks)", () => {
  it("renders a code span inside a link label", () => {
    expect(renderMarkdown("[`cn adopt`](https://example.com/x)")).toBe(`<p><a href="https://example.com/x" ${rel}><code>cn adopt</code></a></p>`);
  });
  it("accepts an angle-bracket destination", () => {
    expect(renderMarkdown("[a](<https://x.example/p>)")).toBe(`<p><a href="https://x.example/p" ${rel}>a</a></p>`);
  });
  it("renders emphasis and code inside a label, and an image as a link with its alt text", () => {
    expect(renderMarkdown("[**b** `c`](/p)")).toBe(`<p><a href="/p" ${rel}><strong>b</strong> <code>c</code></a></p>`);
    expect(renderMarkdown("![alt text](https://x.example/i.png)")).toBe(`<p><a href="https://x.example/i.png" ${rel}>alt text</a></p>`);
  });
  it("never emits the private-use marker", () => {
    for (const s of ["[`a`](<`b`>)", "`[a](b)`", "[[`a`](b)](c)", "[`a`]`b`(c)", "0"]) {
      expect(renderMarkdown(s)).not.toContain("");
    }
  });
  it("does not nest links", () => {
    const html = renderMarkdown("[a [b](/inner) c](/outer)");
    expect(html.match(/<a /g)?.length).toBe(1);
  });
});

describe("links", () => {
  it("keeps balanced parentheses in the destination", () => {
    expect(renderMarkdown("[w](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(`<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" ${rel}>w</a></p>`);
    expect(renderMarkdown("([w](https://x.example/a))")).toBe(`<p>(<a href="https://x.example/a" ${rel}>w</a>)</p>`);
  });
  it("ignores a title after the destination", () => {
    expect(renderMarkdown(`[a](https://x.example "title")`)).toBe(`<p><a href="https://x.example" ${rel}>a</a></p>`);
  });
  it("resolves reference links, case-insensitively, and drops the definition", () => {
    const html = renderMarkdown("See [the docs][Docs], [Docs] and [text][].\n\n[docs]: https://x.example/d \"Docs\"\n[text]: <https://x.example/t>");
    expect(html).toContain(`<a href="https://x.example/d" ${rel}>the docs</a>`);
    expect(html).toContain(`<a href="https://x.example/d" ${rel}>Docs</a>`);
    expect(html).toContain(`<a href="https://x.example/t" ${rel}>text</a>`);
    expect(html).not.toContain("]:");
  });
  it("leaves an undefined reference as text", () => {
    expect(renderMarkdown("[nope][missing]")).toBe("<p>[nope][missing]</p>");
  });
  it("refuses an unsafe reference destination", () => {
    const html = renderMarkdown("[x][r]\n\n[r]: javascript:alert(1)");
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain("<a");
  });
  it("escapes the destination so an entity cannot decode into a scheme", () => {
    expect(renderMarkdown("[x](&#x6a;avascript:alert(1))")).toContain(`href="&amp;#x6a;avascript:alert(1)"`);
    expect(renderMarkdown("[x](java&#9;script:alert(1))")).toContain(`href="java&amp;#9;script:alert(1)"`);
  });
  it("renders autolinks", () => {
    expect(renderMarkdown("<https://x.example/a?b=1&c=2>")).toBe(`<p><a href="https://x.example/a?b=1&amp;c=2" ${rel}>https://x.example/a?b=1&amp;c=2</a></p>`);
  });
});

describe("text", () => {
  it("does not escape an existing entity again", () => {
    expect(renderMarkdown("a &copy; b &#169; c &#xA9; d")).toBe("<p>a &copy; b &#169; c &#xA9; d</p>");
  });
  it("still escapes a bare ampersand and an unfinished entity", () => {
    expect(renderMarkdown("R&D &copy and &;")).toBe("<p>R&amp;D &amp;copy and &amp;;</p>");
  });
  it("shows an entity-encoded tag as text", () => {
    expect(renderMarkdown("&lt;script&gt;")).toBe("<p>&lt;script&gt;</p>");
  });
  it("honours backslash escapes", () => {
    expect(renderMarkdown("\\*not em\\* and \\[x\\](y)")).toBe("<p>*not em* and [x](y)</p>");
  });
  it("drops comments and tags but keeps comparison text", () => {
    expect(renderMarkdown("a <!-- hidden [x](/y) --> b")).toBe("<p>a  b</p>");
    expect(renderMarkdown("1 < 2 and 3 > 2")).toBe("<p>1 &lt; 2 and 3 &gt; 2</p>");
  });
});

describe("emphasis", () => {
  it("nests strong and em properly", () => {
    expect(renderMarkdown("***both***")).toBe("<p><em><strong>both</strong></em></p>");
    expect(renderMarkdown("**a *b* c**")).toBe("<p><strong>a <em>b</em> c</strong></p>");
    expect(renderMarkdown("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
  });
  it("never misnests", () => {
    const html = renderMarkdown("__a *b__ c*");
    const tags = [...html.matchAll(/<(\/?)(strong|em)>/g)];
    const stack: string[] = [];
    for (const [, close, name] of tags) {
      if (!close) stack.push(name ?? "");
      else expect(stack.pop()).toBe(name);
    }
    expect(stack).toEqual([]);
  });
  it("leaves intraword underscores and unmatched markers alone", () => {
    expect(renderMarkdown("snake_case_name and 2 * 3 * 4")).toBe("<p>snake_case_name and 2 * 3 * 4</p>");
    expect(renderMarkdown("**open")).toBe("<p>**open</p>");
  });
});

describe("blocks", () => {
  it("parses headings with closing hashes and spaces", () => {
    expect(renderMarkdown("## Title ##")).toBe("<h3>Title</h3>");
    expect(renderMarkdown("#   spaced   ")).toBe("<h2>spaced</h2>");
    expect(renderMarkdown("#nospace")).toBe("<p>#nospace</p>");
    expect(renderMarkdown("####### seven")).toBe("<p>####### seven</p>");
  });
  it("caps blockquote nesting", () => {
    const html = renderMarkdown("> > > > > > > > > > deep");
    expect((html.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(html).toContain("deep");
  });
});
