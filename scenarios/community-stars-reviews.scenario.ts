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
