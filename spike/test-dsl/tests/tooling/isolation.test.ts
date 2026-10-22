// Tooling property, not a product requirement: storage is recreated between scenarios,
// so nothing published earlier is visible later.
import { afterAll, beforeAll, expect, test } from "vitest";
import { InProcessDriver } from "../drivers/inprocess";
import { World } from "../world/world";
import "../world/matchers";

const driver = new InProcessDriver();
beforeAll(() => driver.start());
afterAll(() => driver.stop());

test.skipIf(!driver.capabilities.reset)("a reset wipes what the previous scenario published", async () => {
  await driver.reset();
  const w1 = new World(driver);
  const alice = await w1.users.create();
  await alice.signIn();
  const pack = await alice.publish(w1.packs.sample({ summary: "isolation probe" }));
  expect(await w1.agents.anonymous().search("isolation")).toContain(pack);

  await driver.reset();
  const w2 = new World(driver);
  expect(await w2.agents.anonymous().search("isolation")).toEqual([]);
  await expect(w2.users.create().then((u) => u.view(pack))).resolves.toBeNotFound();
});
