import { scenario, expect } from "../world/scenario";

scenario("REQ-SPIKE-002 publishing records every external call and every write, in order", async (world) => {
  const alice = await world.users.create();
  await alice.signIn();
  await alice.publish(world.packs.sample({ visibility: "private" }));
  await world.settle();

  // Seen from outside the system: the two outside dependencies it is allowed to call.
  expect(world.recorder.external().map((e) => `${e.target} ${e.op}`)).toEqual([
    "oidc.test signing-keys",
    "llm.test validate",
  ]);

  // Seen from inside: what it wrote, in order.
  expect(world.recorder.writes().map((e) => `${e.target}.${e.op}`)).toEqual([
    "sessions.insert",
    "packs.insert",
    "ARCHIVES.put",
    "packs.update",
  ]);

  // Every entry has the shape a wet-run/dry-run comparison needs.
  for (const e of world.recorder.entries) {
    expect(e).toMatchObject({ seq: expect.any(Number), kind: expect.any(String), target: expect.any(String), op: expect.any(String) });
  }
  expect(world.recorder.entries.map((e) => e.seq)).toEqual(world.recorder.entries.map((_, i) => i + 1));
}, { needs: ["recorder"] });
