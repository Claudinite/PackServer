import { scenario, expect } from "../world/scenario";

scenario("REQ-SEARCH-001 REQ-SEARCH-013 a public pack is found by anonymous agents and by the site search alike", async (world) => {
  const alice = await world.users.create();
  await alice.signIn();
  const pack = await alice.publish(world.packs.sample({ summary: "Tunes postgres indexes" }));

  const agent = world.agents.anonymous();
  expect(await agent.search("postg")).toContain(pack);

  const visitor = await world.users.create();
  expect(await visitor.search("postg")).toContain(pack);
});

scenario("REQ-SPIKE-001 publishing requires a signed-in user", async (world) => {
  const stranger = await world.users.create();
  await expect(stranger.tryPublish(world.packs.sample())).resolves.toBeRefused("unauthenticated");
});

scenario("REQ-VAL-001 a published pack carries the validator's verdict", async (world) => {
  const alice = await world.users.create();
  await alice.signIn();
  world.validation.willSay("flag");
  const pack = await alice.publish(world.packs.sample());

  await expect(alice.view(pack)).resolves.toSucceedWith({ validation: "flag" });
});
