import { describe, expect, it } from "vitest";
import { canonicaliseArchive, isCanonical } from "@packserver/core/canonical";
import { fixtureArchive } from "@packserver/core/canonical/fixtures";
import { acceptedCorpus, refusedCorpus } from "../../fixtures/bombs/index.ts";
import { runA } from "../a-run.ts";
import { fitToCap, SandboxAReport } from "../a-report.ts";
import { loadOptionalInspectors, type Inspector } from "../a-inspectors.ts";
import { REQUEST } from "./helpers.ts";

const hooks = { imageDigest: "sha256:" + "a".repeat(64) };

describe("refused uploads (IT-VAL-003, 020, 022, 023)", () => {
  it.each(refusedCorpus().map((c) => [c.name, c] as const))("%s is refused with its reason and yields no archive", async (_name, c) => {
    const { report, canonical } = await runA(c.build(), REQUEST, hooks);
    expect(report.outcome).toBe("refused");
    expect(report.refusal?.reason).toBe(c.expect);
    expect(report.findings.map((f) => [f.rule, f.class])).toEqual([[c.expect, "fail"]]);
    expect(report.tree_hash).toBeNull();
    expect(canonical).toBeNull();
    expect(SandboxAReport.parse(report)).toEqual(report);
  });
});

describe("extraction crash", () => {
  it("an unexpected decoder failure is a final archive.unsafe", async () => {
    const { report, canonical } = await runA(null as unknown as Uint8Array, REQUEST, hooks);
    expect(report.outcome).toBe("refused");
    expect(report.refusal).toEqual({ reason: "archive.unsafe", code: "extract-crash" });
    expect(report.findings.map((f) => f.rule)).toEqual(["archive.unsafe"]);
    expect(canonical).toBeNull();
  });
});

describe("accepted uploads (IT-VAL-033, IT-VAL-051)", () => {
  it.each(acceptedCorpus().map((c) => [c.name, c] as const))("%s comes back as the canonical re-pack", async (_name, c) => {
    const upload = c.build();
    const { report, canonical } = await runA(upload, { ...REQUEST, pack: "@acme/" + c.name }, hooks);
    expect(report.outcome).toBe("ok");
    const host = await canonicaliseArchive(upload);
    expect(Buffer.from(canonical!).equals(Buffer.from(host.archive))).toBe(true);
    expect(report.canonical_sha256).toBe(host.sha256);
    expect(report.tree_hash).toBe(host.treeHash);
    expect(report.round_trip_ok).toBe(true);
    expect(report.pack_code_executed).toBe(false);
    expect(await isCanonical(canonical!)).toBe(true);
  });

  it("changes the bytes of an untidy upload and leaves a canonical one alone", async () => {
    const upload = fixtureArchive("gcp");
    const first = await runA(upload, REQUEST, hooks);
    expect(Buffer.from(first.canonical!).equals(Buffer.from(upload))).toBe(false);
    const second = await runA(first.canonical!, REQUEST, hooks);
    expect(Buffer.from(second.canonical!).equals(Buffer.from(first.canonical!))).toBe(true);
    expect(second.report.tree_hash).toBe(first.report.tree_hash);
  });

  it("carries the static findings and the image digest", async () => {
    const { report } = await runA(fixtureArchive("with-secret"), { ...REQUEST, pack: "@acme/leaky" }, hooks);
    expect(report.image_digest).toBe(hooks.imageDigest);
    expect(report.findings.some((f) => f.class === "fail")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("wJalrXUtnFEMI");
  });

  it("tells the supervisor when extraction is over", async () => {
    let calls = 0;
    await runA(fixtureArchive("gcp"), REQUEST, { ...hooks, onExtracted: () => calls++ });
    await runA(fixtureArchive("bomb-quine"), REQUEST, { ...hooks, onExtracted: () => calls++ });
    expect(calls).toBe(1);
  });
});

describe("optional inspectors", () => {
  it("is skipped, and says so, while the capability module is absent", async () => {
    const { inspectors, skipped } = await loadOptionalInspectors();
    expect(inspectors).toEqual([]);
    expect(skipped).toEqual([{ name: "@packserver/core/capabilities", note: "module not present in this image" }]);
    const { report } = await runA(fixtureArchive("gcp"), REQUEST, { ...hooks, skippedInspectors: skipped });
    expect(report.inspectors).toEqual([{ name: "@packserver/core/capabilities", status: "skipped", note: "module not present in this image" }]);
  });

  it("does not hide a module that exists but is broken", async () => {
    await expect(loadOptionalInspectors(["node:path"])).rejects.toThrow("exports no inspector");
  });

  it("does not take a missing dependency of a present module for an absent module", async () => {
    const broken = "data:text/javascript,import 'no-such-package-for-test';";
    await expect(loadOptionalInspectors([broken])).rejects.toThrow();
  });

  it("runs an inspector when one is present and takes its findings and capabilities", async () => {
    const seen: unknown[] = [];
    const inspector: Inspector = {
      name: "fake-capabilities",
      inspect: async ({ tree, previousCapabilities }) => {
        seen.push(previousCapabilities, tree.files.length);
        return { findings: [{ rule: "x.rule", class: "hold", file: null, line: null, quote: null, hint: "h" }], capabilities: { guards: [] } };
      },
    };
    const { report } = await runA(fixtureArchive("gcp"), { ...REQUEST, previous_capabilities: { old: true } }, { ...hooks, inspectors: [inspector] });
    expect(seen[0]).toEqual({ old: true });
    expect(report.capabilities).toEqual({ guards: [] });
    expect(report.findings.at(-1)?.rule).toBe("x.rule");
    expect(report.inspectors).toEqual([{ name: "fake-capabilities", status: "ran", note: null }]);
  });

  it("an inspector that throws is an infrastructure error, not a clean pass", async () => {
    const inspector: Inspector = { name: "bad", inspect: async () => Promise.reject(new Error("secret detail")) };
    const { report, canonical } = await runA(fixtureArchive("gcp"), REQUEST, { ...hooks, inspectors: [inspector] });
    expect(report.outcome).toBe("error");
    expect(report.error).toBe("inspection crashed");
    expect(canonical).toBeNull();
  });
});

describe("report cap", () => {
  it("sheds findings and urls to fit, and refuses a report that still does not", async () => {
    const { report } = await runA(fixtureArchive("gcp"), REQUEST, hooks);
    const fat = { ...report, findings: Array.from({ length: 20_000 }, (_, i) => ({ rule: "docs.readme-missing", class: "warn" as const, file: "f", line: i + 1, quote: null, hint: "h".repeat(100) })) };
    const fitted = fitToCap(fat)!;
    expect(fitted.findings_truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(1024 * 1024);
    const oversized = fitToCap({ ...report, manifest: { big: "x".repeat(2 * 1024 * 1024) } })!;
    expect(oversized.manifest).toBeNull();
    expect(oversized.findings_truncated).toBe(true);
    expect(fitToCap({ ...report, error: "x".repeat(2 * 1024 * 1024) })).toBeNull();
  });
});
