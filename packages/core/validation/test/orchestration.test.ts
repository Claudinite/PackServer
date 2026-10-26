import type { Finding } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { dedupeFindings, orderFindings, verdictOf } from "../orchestration/verdict.ts";
import { stepOfRule } from "../orchestration/steps.ts";
import { chunkFiles, delimited } from "../prose-screen/index.ts";

const finding = (over: Partial<Finding>): Finding => ({ rule: "text.example", class: "warn", ...over }) as Finding;

describe("verdictOf", () => {
  it("is the worst class among the findings, and a pass when there are none", () => {
    expect(verdictOf([])).toBe("pass");
    expect(verdictOf([finding({ class: "warn" })])).toBe("warn");
    expect(verdictOf([finding({ class: "warn" }), finding({ class: "hold" })])).toBe("hold");
    expect(verdictOf([finding({ class: "hold" }), finding({ class: "fail" })])).toBe("fail");
  });
  it("fails when a step failed, whatever it found", () => {
    expect(verdictOf([], true)).toBe("fail");
  });
});

describe("finding lists", () => {
  it("keeps one finding per rule, place and excerpt", () => {
    const a = finding({ file: "README.md", line: 3, quote: "x" });
    expect(dedupeFindings([a, { ...a }, finding({ file: "README.md", line: 4, quote: "x" })])).toHaveLength(2);
  });
  it("orders failures first, then holds, then warnings, each by file and line", () => {
    const ordered = orderFindings([
      finding({ rule: "w", class: "warn", file: "a", line: 1 }),
      finding({ rule: "f2", class: "fail", file: "b", line: 1 }),
      finding({ rule: "f1", class: "fail", file: "a", line: 9 }),
      finding({ rule: "h", class: "hold", file: "a", line: 1 }),
    ]);
    expect(ordered.map((f) => f.rule)).toEqual(["f1", "f2", "h", "w"]);
  });
});

describe("stepOfRule", () => {
  it("reports each rule family from the step that finds it", () => {
    expect(stepOfRule("archive.bomb")).toBe("extraction");
    expect(stepOfRule("manifest.missing")).toBe("manifest");
  });
});

describe("prose chunks", () => {
  it("splits on line boundaries and keeps every line", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    const chunks = chunkFiles([{ path: "README.md", text }], 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join("\n")).toBe(text);
    expect(chunks[0]!.start_line).toBe(1);
  });
  it("cuts a single over-long line rather than dropping it", () => {
    const chunks = chunkFiles([{ path: "a.md", text: "y".repeat(5000) }], 100);
    expect(chunks.map((c) => c.text).join("")).toBe("y".repeat(5000));
  });
  it("refuses to delimit a chunk that contains the nonce", () => {
    const chunk = { id: "1", file: "a.md", start_line: 1, end_line: 1, text: "has NONCE inside" };
    expect(() => delimited(chunk, "NONCE")).toThrow();
    expect(delimited(chunk, "other")).toContain("<<<other end>>>");
  });
});
