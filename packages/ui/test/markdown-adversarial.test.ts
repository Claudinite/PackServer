import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

const MIB5 = 5 * 1024 * 1024;
/** Linear renderers finish these in well under a second; the old backtracking ones ran for minutes to hours. */
const BUDGET_MS = 8000;

const repeatTo = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

const shapes: Record<string, string> = {
  "open brackets": repeatTo("[", MIB5),
  "bracket pairs with parens": repeatTo("[a](", MIB5),
  "closing brackets": repeatTo("]", MIB5),
  "nested links": repeatTo("[a](b)[", MIB5),
  "backtick runs of varying length": repeatTo("`a``b```c````", MIB5),
  "unclosed comments": repeatTo("<!--a", MIB5),
  "unclosed autolinks": repeatTo("<https://a.example/", MIB5),
  "unclosed tags": repeatTo("<a ", MIB5),
  "heading with spaces": "# a" + " ".repeat(MIB5) + "x",
  "heading with hashes": "# a " + "#".repeat(MIB5) + " x",
  "emphasis markers": repeatTo("*a_", MIB5),
  "blockquote markers": ">".repeat(MIB5),
  "quote lines": repeatTo("> > > a\n", MIB5),
  "list lines": repeatTo("- a\n", MIB5),
  "spaces": " ".repeat(MIB5),
  "ampersands": repeatTo("&a", MIB5),
  "backslashes": "\\".repeat(MIB5),
  "reference brackets": "[x]: https://x.example\n" + repeatTo("[[a][", MIB5),
};

describe("renderMarkdown on 5 MiB of hostile input", () => {
  for (const [name, input] of Object.entries(shapes)) {
    it(`finishes ${name} within the time budget`, () => {
      const started = performance.now();
      const html = renderMarkdown(input);
      const elapsed = performance.now() - started;
      expect(typeof html).toBe("string");
      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(html).not.toMatch(/<script|/);
    }, 30_000);
  }

  it("renders a quote nested 100000 deep without overflowing the stack", () => {
    const html = renderMarkdown(">".repeat(100_000) + " deep");
    expect(html).toContain("deep");
  });
});
