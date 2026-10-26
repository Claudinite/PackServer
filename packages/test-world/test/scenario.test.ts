import { describe, expect, it } from "vitest";
import { loadSpecs } from "../registry";
import { scenario, specTags } from "../scenario";

describe("scenario()", () => {
  it("refuses a title that does not start with a test id", () => {
    expect(() => scenario("a pack can be yanked", async () => {})).toThrow(/must start with a test id/);
  });

  it("refuses an id no page of docs/testing specifies", () => {
    expect(() => scenario("IT-ACC-999 invented", async () => {})).toThrow(/IT-ACC-999, which no page of docs\/testing specifies/);
  });
});

describe("the probe-safe tag", () => {
  const tags = (id: string, own: string[] = []): string[] => specTags(loadSpecs().tests.get(id)!, own);

  it("comes from the test's Runs row, so the scenario's own body and options stay as they were", () => {
    expect(tags("IT-OPS-002")).toContain("probe-safe");
    expect(tags("IT-OPS-006")).toContain("probe-safe");
    expect(tags("IT-ACC-001")).not.toContain("probe-safe");
  });

  it("is carried once when the scenario also tags itself", () => {
    expect(tags("JT-010", ["probe-safe"]).filter((t) => t === "probe-safe")).toEqual(["probe-safe"]);
    expect(tags("IT-OPS-002", ["probe-safe"]).filter((t) => t === "probe-safe")).toEqual(["probe-safe"]);
  });

  it("keeps the requirement tags first", () => {
    expect(tags("IT-OPS-002")[0]).toBe("req/REQ-OPS-002");
  });
});
