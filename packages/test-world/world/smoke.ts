import { expect } from "vitest";
import type { World } from "./world";

/**
 * What every driver must show before a scenario can trust it: the Workers answer, name their
 * release, names are aliased, and (where the driver has them) time moves and mail is readable.
 */
export const SMOKE = {
  title: "the driver reaches the system and the World keeps its promises",
  async body(world: World): Promise<void> {
    const answers = await world.platform.unknownPath();
    expect(Object.keys(answers)).toEqual(world.platform.workers());
    for (const answer of Object.values(answers)) expect(answer).toEqual({ status: 404, release: world.operator.deployedVersion() });
    expect(world.operator.observedVersions().has(world.operator.deployedVersion())).toBe(true);

    const acme = world.alias("acme");
    expect(acme).toMatch(/^acme-[0-9a-f]{4}$/);
    expect(world.alias("acme")).toBe(acme);
    expect(world.unalias(`@${acme}/gcp`)).toBe("@acme/gcp");

    if (world.platform.capabilities().includes("clock")) {
      const start = await world.clock.now();
      await world.clock.advance("24h1m");
      expect((await world.clock.now()).getTime() - start.getTime()).toBe(24 * 3_600_000 + 60_000);
    }
  },
};
