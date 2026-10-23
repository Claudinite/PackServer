import { describe, expect } from "vitest";
import { bootCount, scenario } from "../scenario";

describe("scenarios in sibling describe blocks share one driver", () => {
  scenario.smoke("the first block reaches the system", async (world) => {
    expect(world.platform.workers().length).toBeGreaterThan(0);
  });
});

describe("a second block", () => {
  scenario.smoke("sees the same driver, booted once", async (world) => {
    expect(world.platform.workers().length).toBeGreaterThan(0);
    expect(world.platform.capabilities()).toContain("fakes");
    expect(bootCount).toBe(1);
  });
});
