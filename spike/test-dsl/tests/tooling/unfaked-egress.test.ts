// Proves the enforcement: a Worker calling an outside host that no fake answers for fails the
// scenario instead of silently reaching the network.
import { afterAll, beforeAll, expect, test } from "vitest";
import { InProcessDriver } from "../drivers/inprocess";
import { World } from "../world/world";

const driver = new InProcessDriver({ llmUrl: "https://nobody-faked-this.test/validate" });
beforeAll(() => driver.start());
afterAll(() => driver.stop());

test("an unfaked outbound call fails the scenario loudly", async () => {
  await driver.reset();
  const world = new World(driver);
  const alice = await world.users.create();
  await alice.signIn(); // oidc.test is faked, so this works
  // MSW's "error" strategy fails the Node-side fetch; Miniflare's loopback turns that into a 500
  // for the Worker, which reports the validator as unreachable. Nothing reached the network.
  await expect(alice.publish(world.packs.sample())).rejects.toThrow(/validator unreachable/);
  // and the fakes never saw a validation call
  expect(world.recorder.external().map((e) => e.op)).toEqual(["signing-keys"]);
});
