import { describe, expect, it } from "vitest";
import { canonSamples } from "../../fixtures/canon-samples/index.ts";
import { runA } from "../a-run.ts";
import { REQUEST } from "./helpers.ts";

const PACKS = new URL("../../fixtures/canon-samples/packs", import.meta.url).pathname;

describe("canon samples", () => {
  it("every sampled canon pack extracts and re-packs without a failing finding", async () => {
    const samples = await canonSamples(PACKS);
    expect(samples.map((s) => s.name)).toEqual(["cloudflare-workers", "html", "jwt"]);
    for (const s of samples) {
      const { report } = await runA(s.archive, { ...REQUEST, pack: "@claudinite/" + s.name }, { imageDigest: null });
      expect(report.outcome, s.name).toBe("ok");
      expect(report.round_trip_ok, s.name).toBe(true);
      expect(report.findings.filter((f) => f.class === "fail"), s.name).toEqual([]);
    }
  });
});
