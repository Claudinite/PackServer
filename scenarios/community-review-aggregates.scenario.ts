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

scenario("IT-COMM-007 Publishers reply once and flag, never delete", async (world) => {
  const { pack, owner, maintainer } = await ownedPack(world, "@acme/gcp");
  const ann = await reader(world);
  const stranger = await reader(world);
  const review = (await world.community.review(ann, pack, { rating: 2, body: "Broke my build." })) as { id: string };

  await expect(world.community.reply(stranger, pack, review, "Nope")).toBeRefused("forbidden");
  expect(await world.community.reply(owner, pack, review, "Fixed in 1.1.0.")).toMatchObject({ reply: { body: "Fixed in 1.1.0." } });
  await expect(world.community.reply(maintainer, pack, review, "Again")).toBeRefused("exists");

  await expect(world.community.flag(stranger, pack, review)).toBeRefused("forbidden");
  expect(await world.community.flag(maintainer, pack, review)).toBe(true);
  expect((await world.community.moderation.flags()).map((f) => f.reviewId)).toEqual([review.id]);

  await expect(world.community.delete(owner, pack, review)).toBeRefused("forbidden");
  expect(await world.community.reviews(pack)).toMatchObject({ reviewCount: 1, reviews: [{ id: review.id, reply: { body: "Fixed in 1.1.0." } }] });
}, NEEDS);

scenario("IT-COMM-009 Rating aggregates use the catalogue-mean prior with a weight of 10", async (world) => {
  const [e, n, filler] = [await world.packs.public("@acme/e"), await world.packs.public("@acme/n"), await world.packs.public("@acme/filler")];
  for (const pack of [e, n, filler]) await world.search.list(pack, { ...LISTED, pitch: "Prior weighted widgets", score: 70 });
  const ann = await reader(world);

  // 40 ratings of 4.5, one of 5 and 21 of 3.0: the catalogue averages exactly 4.0.
  await world.community.seed.reviews(e, { count: 40, average: 4.5 });
  await world.community.seed.reviews(filler, { count: 21, average: 3 });
  await world.community.review(ann, n, { rating: 5 });
  expect(await world.community.recompute()).toMatchObject({ mean: 4 });

  const shown = async (pack: typeof e) => ((await world.community.reviews(pack)) as { rating: number }).rating;
  expect(await shown(n)).toBeCloseTo((10 * 4 + 5) / 11, 6);
  expect(await shown(e)).toBeCloseTo((10 * 4 + 40 * 4.5) / 50, 6);
  expect(await shown(e)).toBeCloseTo(4.4, 6);
  const byRating = await world.search.site("prior weighted widgets", { sort: "rating" });
  expect(byRating.ids.indexOf(e.name)).toBeLessThan(byRating.ids.indexOf(n.name));
  expect(byRating.cards.find((c) => c.id === n.name)?.rating).toBeCloseTo((10 * 4 + 5) / 11, 6);

  // Contrast: the mean moves to 4.5, but a pack's rating follows it only when the hourly job runs.
  await world.community.seed.reviews(filler, { count: 62, average: 5 });
  expect(await shown(n)).toBeCloseTo((10 * 4 + 5) / 11, 6);
  await world.clock.advance("1h");
  expect(await world.community.recompute()).toMatchObject({ mean: 4.5 });
  expect(await shown(n)).toBeCloseTo((10 * 4.5 + 5) / 11, 6);
}, NEEDS);

scenario("IT-COMM-012 A removed review's author is told why", async (world) => {
  const { pack } = await ownedPack(world, "@acme/gcp");
  const ann = await reader(world);
  const review = (await world.community.review(ann, pack, { rating: 1, body: "Call me on 555-0100." })) as { id: string };

  await world.community.moderation.hide(review, "It contains a phone number.");
  await world.community.deliver();
  const mail = world.mail.inbox(ann).all();
  expect(mail).toHaveLength(1);
  expect(`${mail[0]!.subject}\n${mail[0]!.text}`).toContain("It contains a phone number.");
  expect(await world.community.reviews(pack)).toMatchObject({ reviewCount: 0, rating: null, reviews: [] });
  await expect(world.community.review(ann, pack, { rating: 5 })).toBeRefusedSaying("removed");
}, NEEDS);

scenario("IT-COMM-013 Reviews of a yanked pack remain", async (world) => {
  const { pack } = await ownedPack(world, "@acme/gcp", { versions: ["1.0.0"], listed: true });
  const ann = await reader(world);
  await world.community.review(ann, pack, { rating: 4, body: "Handy." });
  expect((await pack.page() as { statusLines: string[] }).statusLines).toEqual([]);

  await pack.version("1.0.0").seed({ status: "yanked", reason: "Broke on Windows" });
  expect(await world.community.reviews(pack)).toMatchObject({ available: false, reviewCount: 1, reviews: [{ body: "Handy." }] });
  const view = (await pack.page()) as { statusLines: string[] };
  expect(view.statusLines.join(" ")).toContain("Unavailable");
}, NEEDS);

scenario("IT-ACC-009 Community actions need only a verified email", async (world) => {
  const { pack } = await ownedPack(world, "@acme/gcp");
  const ann = await reader(world, "2d");

  expect(await world.community.star(ann, pack)).toEqual({ count: 1, starred: true });
  expect(await world.community.review(ann, pack, { rating: 4, body: "Good." })).toMatchObject({ rating: 4 });
  await world.reports.file(ann, pack, { kind: "bug", title: "It crashes" });

  expect(await world.community.stars(pack)).toMatchObject({ count: 1 });
  expect(await world.community.reviews(pack)).toMatchObject({ reviewCount: 1 });
  expect((await world.reports.issues(pack)).map((r) => r.title)).toEqual(["It crashes"]);
}, NEEDS);

scenario("IT-ABUSE-004 A burst of 50 counted stars over ten times the daily average triggers an anomaly hold", async (world) => {
  const names = ["a", "b", "comparable", "rival"];
  const [a, b, comparable, rival] = await Promise.all(names.map((n) => world.packs.public(`@acme/${n}`, { versions: ["1.0.0"] })));
  for (const pack of [a!, b!, comparable!, rival!]) await world.search.list(pack, { ...LISTED, pitch: "Star burst widgets" });
  const ann = await reader(world);
  // Accounts older than the stars they placed, so each star counted the day it was placed.
  const days = { accountAge: "9d", between: { from: "7d", to: "2d" } };

  await world.community.seed.stars(rival!, { count: 60, accountAge: "30d", between: { from: "20d", to: "10d" } });
  await world.community.seed.stars(a!, { count: 28, ...days });
  await world.community.seed.stars(b!, { count: 42, ...days });

  // 49 stars within a day and ann's make 50 for A and B and 49 for the comparable pack.
  await world.community.seed.stars(a!, { count: 49 });
  await world.community.seed.stars(b!, { count: 49 });
  await world.community.seed.stars(comparable!, { count: 48 });
  for (const pack of [a!, b!, comparable!]) await world.community.star(ann, pack);

  const holds = await world.community.moderation.holds();
  expect(holds).toHaveLength(1);
  expect(holds[0]).toMatchObject({ pack: a!.name, stars: 50, dailyAverage: 4 });

  // Rank holds still and the public figure is the one the rank uses, so nothing tells of a hold; no star is removed.
  expect((await world.search.site("star burst widgets", { sort: "stars" })).ids).toEqual([b!.name, rival!.name, comparable!.name, a!.name]);
  expect(await world.community.stars(a!)).toEqual({ count: 28, starred: false });
  expect(((await a!.page()) as { text: string }).text.toLowerCase()).not.toContain("hold");

  await world.clock.advance("7d");
  await world.clock.advance("1h");
  await world.community.recompute();
  expect((await world.search.site("star burst widgets", { sort: "stars" })).ids).toEqual([b!.name, a!.name, rival!.name, comparable!.name]);
  expect(await world.community.stars(a!)).toEqual({ count: 78, starred: false });
}, NEEDS);
