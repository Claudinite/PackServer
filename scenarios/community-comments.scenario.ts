import { expect, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage"] };

// Section comments and votes on a pack's readable contents.

/** A signed-in person whose account is old enough to count, unless a scenario says how old. */
async function reader(world: World, age = "3d") {
  const who = await world.users.create();
  await who.signIn();
  await world.community.setAge(who, age);
  return who;
}

/** The comments on a section, which must exist. */
async function thread(world: World, pack: Parameters<World["community"]["comments"]>[0], section: string, viewer?: Parameters<World["community"]["comments"]>[2]) {
  const read = await world.community.comments(pack, section, viewer);
  if (!Array.isArray(read)) throw new Error("the pack was not found");
  return read;
}

/** A public pack with a readable RULES.md; returns the anchors of three of its sections. */
async function packWithRules(world: World) {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  await world.search.list(pack, { pitch: "Cloud rules", category: "cloud", parts: ["rules"] });
  await pack.seedContents("1.0.0", { readme: "# gcp\n", files: [{ path: "RULES.md", text: "# Rules\nBe careful.\n## Secrets\nNever print them.\n## Logging\nKeep it short.\n" }] });
  const view = await pack.page("contents");
  if (!("anchors" in view)) throw new Error("the Contents tab is missing");
  const anchor = (heading: string) => {
    const found = view.anchors.find((a) => a.includes("RULES.md") && a.endsWith(`~${heading}`));
    if (!found) throw new Error(`RULES.md has no ${heading} section`);
    return found;
  };
  return { pack, section: anchor("secrets"), rules: anchor("rules"), logging: anchor("logging") };
}

scenario("IT-COMM-015 Section comments and votes on pack contents", async (world) => {
  const { pack, section, rules, logging } = await packWithRules(world);
  const owner = await reader(world);
  await world.reports.seedRole(pack, owner, "owner");
  const [author, a, b] = [await reader(world), await reader(world), await reader(world)];
  const young = await reader(world, "1h");

  expect(await world.community.commentsCollapsed(pack, section)).toBe(true);

  // Comment accounts follow the review rules: a young account is refused, and so is the eleventh comment in a day.
  await expect(world.community.comment(young, pack, { section: rules, body: "First!" })).toBeRefusedSaying("24 hours");
  expect(await thread(world, pack, rules)).toEqual([]);
  for (let i = 1; i <= 10; i++) expect(await world.community.comment(author, pack, { section: rules, body: `Note ${i}` })).toMatchObject({ body: `Note ${i}` });
  await expect(world.community.comment(author, pack, { section: rules, body: "Note 11" })).toBeRefused("quota");

  // A section the version does not have is refused.
  await expect(world.community.comment(a, pack, { section: "f:RULES.md~nope", body: "Hmm" })).toBeRefused("forbidden");
  expect(await thread(world, pack, "f:RULES.md~nope")).toEqual([]);

  // A comment the text checks flag is held for its author alone.
  const token = "ghp_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6";
  const held = await world.community.comment(a, pack, { section: logging, body: `Use ${token} here` });
  expect(held).toMatchObject({ held: true });
  expect(await thread(world, pack, logging, a)).toEqual([expect.objectContaining({ held: true })]);
  expect(await thread(world, pack, logging, b)).toEqual([]);
  expect(await thread(world, pack, logging)).toEqual([]);
  await expect(world.community.vote(b, pack, held as { id: string }, 1)).toBeNotFound();

  // Votes from a young account and from the pack's own scope do not count, and the author cannot vote.
  const posted = await world.community.comment(b, pack, { section, body: "This should name the secret store." });
  expect(posted).toMatchObject({ section, version: "1.0.0", up: 0, down: 0, hidden: false });
  const comment = posted as { id: string };
  expect(await world.community.vote(young, pack, comment, -1)).toMatchObject({ up: 0, down: 0 });
  expect(await world.community.vote(owner, pack, comment, -1)).toMatchObject({ up: 0, down: 0 });
  await expect(world.community.vote(b, pack, comment, 1)).toBeRefused("forbidden");
  expect(await world.community.vote(a, pack, comment, -1)).toMatchObject({ up: 0, down: 1, mine: -1 });
  expect(await world.community.vote(author, pack, comment, -1)).toMatchObject({ up: 0, down: 2 });
  // A vote is changed or taken back, never doubled.
  expect(await world.community.vote(author, pack, comment, -1)).toMatchObject({ down: 2 });
  expect(await world.community.vote(author, pack, comment, 0)).toMatchObject({ down: 1, mine: null });
  expect(await world.community.vote(author, pack, comment, -1)).toMatchObject({ down: 2 });

  await world.clock.advance("2d");
  // The young account's vote counts once its account is a day old; the owner's and the author's never do.
  expect(await thread(world, pack, section)).toEqual([expect.objectContaining({ id: comment.id, hidden: false, up: 0, down: 3 })]);
  await world.clock.advance("1d1h");
  expect(await thread(world, pack, section)).toEqual([expect.objectContaining({ id: comment.id, hidden: true })]);

  // Contrast: net-positive and net-zero comments of the same age are not hidden.
  await b.signIn();
  const liked = (await world.community.comment(b, pack, { section, body: "Thanks for this." })) as { id: string };
  await world.clock.advance("3d1h");
  await a.signIn();
  await author.signIn();
  await world.community.vote(a, pack, liked, 1);
  expect((await thread(world, pack, section)).find((c) => c.id === liked.id)).toMatchObject({ hidden: false, up: 1 });
  await world.community.vote(author, pack, liked, -1);
  expect((await thread(world, pack, section)).find((c) => c.id === liked.id)).toMatchObject({ hidden: false, up: 1, down: 1 });
}, NEEDS);
