import { describe, expect, it } from "vitest";
import { editDistance, isNearMiss, runStaticRules, skeleton } from "../index.ts";
import { cleanFiles, fakePorts, input } from "./helpers.ts";

const check = async (pack: string, ports = fakePorts()) =>
  (await runStaticRules(input(cleanFiles(), { pack }), ports)).findings;
const rulesOf = async (pack: string, ports = fakePorts()) => (await check(pack, ports)).map((f) => f.rule);

describe("reserved words and domain labels (IT-PUB-018)", () => {
  it("refuses reserved words and verified domain labels with a suggestion; accepts acme-tools", async () => {
    for (const name of ["fleet", "local", "global", "canon", "claudinite", "cn", "temp", "admin", "claude", "anthropic", "probe", "packserver-canary"]) {
      const f = await check(`@z/${name}`);
      expect(f.map((x) => x.rule), name).toEqual(["identity.reserved-word"]);
      expect(f[0]!.hint).toMatch(/Try @z\//);
    }
    const dom = await check("@z/acme");
    expect(dom.map((x) => x.rule)).toContain("identity.verified-domain-collision");
    expect(dom[0]!.hint).toMatch(/Try /);
    expect(await rulesOf("@z/acme-tools")).toEqual([]);
  });

  it("lets the proving scope use its own domain label", async () => {
    expect(await rulesOf("@acme/acme")).toEqual([]);
  });
});

describe("near misses (IT-PUB-034)", () => {
  it("refuses a swap of a popular pack and a Cyrillic lookalike", async () => {
    expect(await rulesOf("@z/gpc")).toEqual(["identity.near-popular-pack"]);
    const lookalike = await rulesOf("@z/gc\u0440");
    expect(lookalike).toContain("identity.name-not-ascii");
    expect(lookalike).toContain("identity.near-popular-pack");
    expect(await rulesOf("@z/gc\u0441")).toContain("identity.near-popular-pack");
  });

  it("refuses a non-ASCII scope and holds a near miss on a verified scope", async () => {
    expect(await rulesOf("@acm\u0435/tools")).toContain("identity.name-not-ascii");
    const held = await check("@acmee/tools");
    expect(held.map((f) => [f.rule, f.class])).toEqual([["identity.near-verified-scope", "hold"]]);
  });

  it("compares the full id and ignores the popular pack's own scope", async () => {
    expect(await rulesOf("@acm/gcp")).toContain("identity.same-name-near-scope");
    expect(await rulesOf("@acme-io/gcp")).toEqual(["identity.same-name-near-scope"]);
    expect((await check("@acme-io/gcp"))[0]!.class).toBe("hold");
    expect(await rulesOf("@acme/gcp-extra")).toEqual([]);
    expect(await rulesOf("@acme/gcp")).toEqual([]);
    expect(await rulesOf("@z/gcp")).toEqual([]);
    expect(await rulesOf("@somebody/gcp")).toEqual([]);
  });

  it("catches lookalike letters and digits", async () => {
    expect(await rulesOf("@z/terraforrn-tips")).toContain("identity.near-popular-pack");
    expect(await rulesOf("@z/te0rraform-tips")).toContain("identity.near-popular-pack");
  });

  it("does not flag unrelated names", async () => {
    expect(await rulesOf("@z/kubernetes-notes")).toEqual([]);
    expect(await rulesOf("@z/aws")).toEqual([]);
  });

  it("measures distance with swaps as one edit", () => {
    expect(editDistance("gcp", "gpc")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(isNearMiss("pack", "pack")).toBe(false);
    expect(skeleton("\u0430pple")).toBe(skeleton("apple"));
  });
});

describe("rulings after review", () => {
  it("normalises reserved words through confusables and separators", async () => {
    for (const name of ["c1aude", "cl-aude", "claude-", "f1eet", "Cn"]) {
      expect(await rulesOf(`@z/${name.toLowerCase()}`), name).toContain("identity.reserved-word");
    }
    expect(await rulesOf("@z/clauded")).toEqual([]);
  });

  it("refuses an ASCII lookalike of a verified scope and holds a plain near miss", async () => {
    const f = await check("@acrne/tools");
    expect(f.map((x) => [x.rule, x.class])).toEqual([["identity.confusable-verified-scope", "fail"]]);
    expect((await check("@acmee/tools"))[0]!.class).toBe("hold");
  });

  it("passes a name equal to a verified scope that is not a domain label", async () => {
    expect(await rulesOf("@z/claudinite-notes")).toEqual([]);
    const ports = fakePorts({ verifiedScopes: async () => ["acme", "stripe"] });
    expect(await rulesOf("@z/stripe", ports)).toEqual([]);
  });
});
