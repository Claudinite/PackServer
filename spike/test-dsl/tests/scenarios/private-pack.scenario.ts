import { scenario, expect } from "../world/scenario";

scenario("REQ-PRIV-001 a private pack looks nonexistent to other members and to agents", async (world) => {
  const alice = await world.users.create();
  await alice.signIn();
  const pack = await alice.publish(world.packs.sample({ visibility: "private" }));

  const bob = await world.users.create();
  await bob.signIn();
  await expect(bob.view(pack)).resolves.toBeNotFound();
  await expect(bob.download(pack)).resolves.toBeNotFound();

  const agent = world.agents.anonymous();
  expect(await agent.search(pack.name)).not.toContain(pack);
});

scenario("REQ-PRIV-001 the owner of a private pack still sees and downloads it", async (world) => {
  const alice = await world.users.create();
  await alice.signIn();
  const pack = await alice.publish(world.packs.sample({ visibility: "private" }));

  await expect(alice.view(pack)).resolves.toSucceedWith({ name: pack.name, visibility: "private" });
  await expect(alice.download(pack)).resolves.toSucceedWith(pack.spec.archive);
});
