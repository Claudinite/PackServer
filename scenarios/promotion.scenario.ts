import { expect, scenario } from "@packserver/test-world";

scenario("IT-VAL-019 Promotion is idempotent per version and commits at one point (the promoted version)", async (world) => {
  const publisher = await world.publishers.create({ handle: "pat" });
  const archive = world.archive("gcp", { version: "1.0.0" });
  const version = await publisher.publish(archive).as("@pat/gcp@1.0.0");
  await world.validation.completes(version);
  await version.promoted();

  expect(await version.status()).toBe("active");
  const published = await version.published();
  expect(published.objects.map((o) => o.kind).sort()).toEqual(["archive", "attestation", "meta", "sha256"]);
  expect(published.canonicalSha256).toBe((await world.validation.of(version).then((r) => r.commit())).canonicalSha256);

  await expect.poll(() => world.mail.inbox(publisher).all().length, { timeout: 20_000 }).toBe(1);
  expect((await world.search.site()).cards.filter((c) => c.id === version.pack.name)).toHaveLength(1);

  await expect(publisher.publish(archive).as("@pat/gcp@1.0.0")).toBeRefused("exists");
  expect(await version.published()).toEqual(published);
  expect(world.mail.inbox(publisher).all()).toHaveLength(1);
});

scenario("IT-PUB-021 Every version carries a registry-signed attestation over both hashes (the promoted version)", async (world) => {
  const publisher = await world.publishers.create({ handle: "pat" });
  const archive = world.archive("gcp", { version: "1.0.0" });
  const version = await publisher.publish(archive).as("@pat/gcp@1.0.0");
  await world.validation.completes(version);
  const published = await (await version.promoted()).published();

  expect(published.attestation.verifies).toBe(true);
  expect(published.attestation.document).toMatchObject({
    pack: version.pack.systemName,
    version: "1.0.0",
    upload_sha256: archive.sha256,
    canonical_sha256: published.canonicalSha256,
    provenance: { source: "upload", source_verified: false },
    rules_version: expect.any(String),
    kid: expect.any(String),
  });
  expect(published.shaFile).toBe(published.canonicalSha256);
});

scenario("IT-PUB-035 Every promoted version emails every owner (the publishing owner)", async (world) => {
  const publisher = await world.publishers.create({ handle: "pat" });
  const version = await publisher.publish(world.archive("gcp", { version: "1.0.0" })).as("@pat/gcp@1.0.0");
  await world.validation.completes(version);
  await version.promoted();

  await expect.poll(() => world.mail.inbox(publisher).all().length, { timeout: 20_000 }).toBe(1);
  const notice = world.mail.inbox(publisher).latest();
  expect(notice.subject).toBe(`${version.pack.systemName} 1.0.0 was published`);
  expect(notice.text).toContain("web upload");
  expect(notice.text).toContain("pat");
});

scenario("IT-DELIV-003 Signed, dated, serialised per-scope and root indexes with content-addressed scope files (a published scope)", async (world) => {
  const publisher = await world.publishers.create({ handle: "pat" });
  const version = await publisher.publish(world.archive("gcp", { version: "1.0.0" })).as("@pat/gcp@1.0.0");
  await world.validation.completes(version);
  await version.promoted();

  const indexes = await world.registry.indexes(version.pack);
  expect(indexes.root.verifies).toBe(true);
  expect(indexes.scope.verifies).toBe(true);
  expect(indexes.root.listsScope).toMatchObject({ sha256: indexes.scope.sha256, serial: indexes.scope.document.serial });
  expect(indexes.scope.aliasIsTheHashedFile).toBe(true);
  expect(indexes.root.lifetimeMs).toBe(7 * 24 * 3_600_000);
  expect(indexes.scope.lifetimeMs).toBe(7 * 24 * 3_600_000);
  expect(indexes.root.document.serial).toBeGreaterThanOrEqual(1);
  expect(indexes.scope.document.serial).toBeGreaterThanOrEqual(1);
  expect(indexes.scope.document.packs[0]).toMatchObject({ name: version.pack.systemName, latest_eligible: "1.0.0" });
});

scenario("IT-DELIV-016 Signatures carry a key id (the active key's documents)", async (world) => {
  const publisher = await world.publishers.create({ handle: "pat" });
  const version = await publisher.publish(world.archive("gcp", { version: "1.0.0" })).as("@pat/gcp@1.0.0");
  await world.validation.completes(version);
  const published = await (await version.promoted()).published();
  const indexes = await world.registry.indexes(version.pack);
  const keys = await world.registry.keys();

  expect(keys.verifies).toBe(true);
  const active = keys.document.keys.filter((k) => k.status === "active");
  expect(active).toHaveLength(1);
  expect(indexes.scope.document.kid).toBe(active[0]?.kid);
  expect(indexes.root.document.kid).toBe(active[0]?.kid);
  expect(published.attestation.document.kid).toBe(active[0]?.kid);
});
