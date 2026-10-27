import { expect, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage"] };

// Stars, ratings and reviews.
const LISTED = { pitch: "Format markdown tables", category: "backend" } as const;

/** A signed-in person whose account is old enough to count, unless a scenario says how old. */
async function reader(world: World, age = "3d") {
  const who = await world.users.create();
  await who.signIn();
  await world.community.setAge(who, age);
  return who;
}

/** A public pack whose scope has an owner and a maintainer. */
async function ownedPack(world: World, name: string, opts: { versions?: string[]; listed?: boolean } = {}) {
  const pack = await world.packs.public(name, { versions: opts.versions ?? ["1.0.0", "1.1.0"] });
  const owner = await reader(world);
  const maintainer = await reader(world);
  await world.reports.seedRole(pack, owner, "owner");
  await world.reports.seedRole(pack, maintainer, "maintainer");
  if (opts.listed) await world.search.list(pack, LISTED);
  return { pack, owner, maintainer };
}

scenario("IT-COMM-001 Star and unstar; anonymous clicks redirect to sign-in and back", async (world) => {
  const { pack } = await ownedPack(world, "@acme/gcp");
  const ann = await reader(world);
  expect(await world.community.stars(pack)).toEqual({ count: 0, starred: false });
  expect(await world.community.star(ann, pack)).toEqual({ count: 1, starred: true });
  expect(await world.community.star(ann, pack)).toEqual({ count: 1, starred: true });
  expect(await world.community.unstar(ann, pack)).toEqual({ count: 0, starred: false });

  const visitor = await reader(world);
  const clicked = await world.community.clickStar(pack);
  const target = `/packs/${pack.systemName}/star`;
  expect(clicked.headers.location).toBe(`/signin?next=${encodeURIComponent(target)}`);
  expect(await world.community.stars(pack)).toEqual({ count: 0, starred: false });

  const session = await visitor.signIn({ next: target });
  expect(session.landedOn).toBe(target);
  // Coming back shows the button and places nothing; the click is the star.
  const back = await world.community.follow(visitor, session.landedOn!);
  expect(String(back.body)).toContain(`Star ${pack.systemName}`);
  expect(await world.community.stars(pack, visitor)).toEqual({ count: 0, starred: false });
  expect(await world.community.star(visitor, pack)).toEqual({ count: 1, starred: true });
}, NEEDS);

scenario("IT-COMM-002 Young-account and self stars are not counted", async (world) => {
  const { pack, maintainer } = await ownedPack(world, "@acme/gcp");
  const young = await reader(world, "1h");
  const outsider = await reader(world, "2d");

  for (const who of [young, maintainer, outsider]) await world.community.star(who, pack);
  expect(await world.community.stars(pack)).toEqual({ count: 1, starred: false });
  for (const who of [young, maintainer, outsider]) expect(await world.community.stars(pack, who)).toEqual({ count: 1, starred: true });

  // Contrast: the young account counts once it is a day old.
  await world.clock.advance("23h");
  expect(await world.community.stars(pack)).toEqual({ count: 2, starred: false });
}, NEEDS);

scenario("IT-COMM-003 One rating and review per account per pack, editable", async (world) => {
  const { pack } = await ownedPack(world, "@acme/gcp");
  const ann = await reader(world);
  await world.community.review(ann, pack, { rating: 3, body: "Works, rough edges.", version: "1.0.0" });
  await world.community.review(ann, pack, { rating: 5, body: "Fixed everything.", version: "1.1.0" });

  const shown = await world.community.reviews(pack);
  expect(shown).toMatchObject({ reviewCount: 1, reviews: [{ rating: 5, body: "Fixed everything.", version: "1.1.0" }] });
  expect(shown).not.toBeNotFound();
}, NEEDS);

scenario("IT-COMM-004 No reviewing your own or your org's packs", async (world) => {
  const { pack, owner, maintainer } = await ownedPack(world, "@acme/gcp");
  const leaver = await reader(world);
  await world.reports.seedRole(pack, leaver, "maintainer");

  await expect(world.community.review(owner, pack, { rating: 5 })).toBeRefused("forbidden");
  await expect(world.community.review(maintainer, pack, { rating: 5 })).toBeRefused("forbidden");
  await expect(world.community.review(leaver, pack, { rating: 5 })).toBeRefused("forbidden");
  expect(await world.community.reviews(pack)).toMatchObject({ reviewCount: 0 });

  await world.community.seed.leaveScope(pack, leaver);
  expect(await world.community.review(leaver, pack, { rating: 4 })).toMatchObject({ rating: 4 });
}, NEEDS);

scenario("IT-COMM-005 Young accounts cannot review; ten reviews a day", async (world) => {
  const packs = [];
  for (let i = 0; i < 11; i++) packs.push(await world.packs.public(`@acme/pack${i}`, { versions: ["1.0.0"] }));
  const [first, last] = [packs[0]!, packs[10]!];

  const young = await reader(world, "23h59m");
  await expect(world.community.review(young, first, { rating: 5 })).toBeRefusedSaying("24 hours");
  await world.clock.advance("2m");
  expect(await world.community.review(young, first, { rating: 5 })).toMatchObject({ rating: 5 });

  const busy = await reader(world, "2d");
  for (const pack of packs.slice(0, 10)) expect(await world.community.review(busy, pack, { rating: 4 })).toMatchObject({ rating: 4 });
  await expect(world.community.review(busy, last, { rating: 4 })).toBeRefused("quota");
  // Editing one of the ten is not a new review.
  expect(await world.community.review(busy, first, { rating: 3 })).toMatchObject({ rating: 3 });

  await world.clock.advance("1d");
  await busy.signIn();
  expect(await world.community.review(busy, last, { rating: 4 })).toMatchObject({ rating: 4 });
}, NEEDS);

scenario("IT-COMM-006 Verified-adoption reviews weigh fully", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const comparator = await world.packs.public("@acme/other", { versions: ["1.0.0"] });
  const elsewhere = await world.packs.public("@acme/elsewhere", { versions: ["1.0.0"] });
  for (const listed of [pack, comparator]) await world.search.list(listed, { ...LISTED, pitch: "Verified adoption widgets" });
  const [a, b, c] = [await reader(world), await reader(world), await reader(world)];

  world.github.publicRepo(`${world.alias(a.handle)}/app`, { declares: [pack] });
  expect((await world.github.scan.run({ again: true })).outcome).toBe("completed");
  await world.community.download(c, pack);

  // Two verified 5s and an unverified 1 against three unverified 4s: counted equally the comparator is ahead,
  // with the verified reviews weighing fully the pack is.
  const marks = [];
  for (const [who, rating] of [[a, 5], [b, 1], [c, 5]] as const) marks.push(((await world.community.review(who, pack, { rating })) as { verified_adoption: boolean }).verified_adoption);
  expect(marks).toEqual([true, false, true]);
  await world.community.seed.reviews(comparator, { count: 3, average: 4 });
  await world.community.recompute();
  expect(await world.community.reviews(pack)).toMatchObject({ reviewCount: 3, verifiedCount: 2 });

  const shown = async (listed: typeof pack) => ((await world.community.reviews(listed)) as { rating: number }).rating;
  expect(await shown(pack)).toBeLessThan(await shown(comparator));
  expect((await world.search.site("verified adoption widgets", { sort: "rating" })).ids).toEqual([pack.name, comparator.name]);

  // The next scan no longer finds A's declaration: A's mark stays, and a later review by A carries none.
  await world.community.seed.laterScanFindsNone();
  expect(await world.github.scan.verifiedAdopter(world.alias(a.handle), pack)).toBe(false);
  expect(await world.community.reviews(pack)).toMatchObject({ verifiedCount: 2 });
  expect(await world.community.review(a, elsewhere, { rating: 5 })).toMatchObject({ verified_adoption: false });
}, { needs: ["fakes", "clock", "storage", "reset"] });
