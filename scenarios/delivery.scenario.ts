import { expect, scenario, type ScenarioOpts } from "@packserver/test-world";
import { Refusal } from "@packserver/test-world";
import type { PackBody } from "@packserver/test-world";

const storage: ScenarioOpts = { needs: ["storage"] };

scenario("IT-DELIV-001 Public versions download from write-once URLs the signed index describes", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { verification: { sourceVerified: true } });
  const version = pack.version("1.0.0");

  const detail = await version.detail();
  const stored = await pack.stored("1.0.0");
  expect(stored.objects.map((o) => o.kind).sort()).toEqual(["archive", "attestation", "meta", "sha256"]);
  expect(Object.values(detail.urls ?? {}).map((u) => new URL(u).pathname)).toEqual([
    "/@acme/gcp/1.0.0/pack.tar.zst",
    "/@acme/gcp/1.0.0/pack.tar.zst.sha256",
    "/@acme/gcp/1.0.0/.attestation.json",
    "/@acme/gcp/1.0.0/meta.json",
  ]);
  expect(detail).toMatchObject({
    sha256: stored.canonicalSha256,
    size: expect.any(Number),
    published_at: expect.any(String),
    status: "active",
    verification: { verified: false, verified_domain: null, verified_github_org: null, source_verified: true },
    min_engine_version: "1.0.0",
    requires: [],
    source_commit: null,
    preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] },
  });

  await pack.seedProof({ verified: true, verifiedDomain: "acme.com" });
  expect(await version.verification()).toEqual({ verified: true, verifiedDomain: "acme.com" });
  expect(await pack.stored("1.0.0")).toEqual(stored);
}, storage);

scenario("IT-DELIV-008 Yanked versions fetch by exact version only", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0", "1.2.0"] });
  await pack.version("1.2.0").seed({ status: "yanked", reason: "breaks on cn 1.61004.1" });

  const exact = (await pack.read({ version: "1.2.0" })) as PackBody & { outcome: string };
  expect(exact.outcome).toBe("found");
  expect(exact.version).toMatchObject({ version: "1.2.0", status: "yanked", yanked: true, reason: "breaks on cn 1.61004.1" });
  expect(exact.latest_eligible).toBe("1.1.0");

  const newest = (await pack.read()) as PackBody;
  expect(newest.latest_eligible).toBe("1.1.0");
  expect(newest.version).toMatchObject({ version: "1.1.0", status: "active" });
  expect(newest.versions.find((v) => v.version === "1.2.0")).toMatchObject({ status: "yanked", yanked: true });
}, storage);

scenario("IT-DELIV-009 Removed packs and hard-deleted versions answer status: removed", async (world) => {
  const gone = await world.packs.public("@acme/gone");
  await gone.seedRemoved();
  expect(await gone.read()).toMatchObject({ outcome: "removed", status: "removed", latest_eligible: null });
  expect((await gone.read()) as object).not.toHaveProperty("version.sha256");

  const kept = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0"] });
  await kept.version("1.1.0").seed({ status: "removed" });
  const listing = (await kept.read()) as PackBody;
  expect(listing.latest_eligible).toBe("1.0.0");
  const entry = listing.versions.find((v) => v.version === "1.1.0");
  expect(entry).toMatchObject({ version: "1.1.0", status: "removed" });
  expect(entry).not.toHaveProperty("sha256");
  expect(await kept.version("1.1.0").status()).toBe("removed");
  expect(await kept.read({ version: "1.1.0" })).toMatchObject({ outcome: "removed" });
  await expect(world.packs.verify(await kept.version("1.0.0").sha256(), { ip: "203.0.113.9" })).resolves.toMatchObject({ result: "canonical" });
}, storage);

scenario("IT-DELIV-010 A quarantined version is withheld from every resolver", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["0.9.0", "1.0.0"] });
  await pack.version("1.0.0").seed({ status: "quarantined", reason: "under review: install-url" });

  await expect(pack.read({ version: "1.0.0" })).toBeHeld("under review: install-url");
  const listing = (await pack.read()) as PackBody;
  expect(listing.latest_eligible).toBe("0.9.0");
  expect(listing.versions.find((v) => v.version === "1.0.0")).toMatchObject({ status: "quarantined", reason: "under review: install-url", under_review: true });
  expect(listing.version).toMatchObject({ version: "0.9.0" });
  expect(await pack.version("1.0.0").status()).toBe("quarantined");
}, storage);

scenario("IT-DELIV-013 Private responses are never cached; immutable only on content-addressed keys", async (world) => {
  const pack = await world.packs.public("@acme/gcp");
  const secret = await world.packs.public("@acme/internal", { visibility: "private" });
  const nothing = world.packs.nonexistent("@acme/nope");

  const anonymous = await pack.observe();
  expect(anonymous.headers["cache-control"]).toMatch(/^public, max-age=\d+/);
  expect(anonymous.headers["cache-control"]).not.toMatch(/immutable/);
  expect((await pack.observe({ session: true })).headers["cache-control"]).toBe("private, no-store");

  const stored = await pack.stored("1.0.0");
  expect(stored.objects.find((o) => o.kind === "archive")?.cacheControl).toMatch(/immutable/);

  await expect(secret.read()).toBeNotFound();
  expect(await secret.observe()).toLookTheSameAs(await nothing.observe());
  expect(await secret.observe({ version: "1.0.0" })).toLookTheSameAs(await nothing.observe({ version: "1.0.0" }));
  expect((await secret.observe({ session: true })).headers["cache-control"]).toBe("private, no-store");
}, storage);

// Not covered here: the edge half of IT-DELIV-014 (nosniff on the custom domain, Claudinite/PackServer#142).
// The metadata read back below is what the World wrote with publicObjectHttpMetadata, so it proves the
// constants and the read path, not T-047's writes.
scenario("IT-DELIV-014 Archive contents are never rendered on a registry origin", async (world) => {
  const pack = await world.packs.public("@acme/gcp");
  const { objects } = await pack.stored("1.0.0");
  expect(objects).toHaveLength(4);
  for (const object of objects) {
    expect(object.contentDisposition).toMatch(/^attachment; filename="[^"]+"$/);
    expect(object.contentType).not.toMatch(/html|svg/);
  }
}, storage);

scenario("IT-DELIV-021 Anyone can verify an archive by hash", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0"] });
  const secret = await world.packs.public("@acme/internal", { visibility: "private" });
  const canonical = await pack.stored("1.0.0");
  const hidden = await secret.stored("1.0.0");
  const ip = "203.0.113.10";

  await expect(world.packs.verify(canonical.canonicalSha256, { ip })).resolves.toEqual({
    result: "canonical",
    pack: "@acme/gcp",
    version: "1.0.0",
    status: "active",
  });
  await expect(world.packs.verify(canonical.uploadSha256, { ip })).resolves.toMatchObject({ result: "upload", version: "1.0.0" });
  await pack.version("1.1.0").seed({ status: "yanked", reason: "broken" });
  await expect(world.packs.verify(await pack.version("1.1.0").canonicalSha256(), { ip })).resolves.toMatchObject({ result: "canonical", version: "1.1.0", status: "yanked" });

  const random = await world.packs.verify("f".repeat(64), { ip });
  expect(random).toEqual({ result: "unknown" });
  expect(await world.packs.verify(hidden.canonicalSha256, { ip })).toEqual(random);
  expect(await world.packs.verify(hidden.uploadSha256, { ip })).toEqual(random);

  const burst = "203.0.113.77";
  const answers = [];
  for (let i = 0; i < 100; i++) answers.push(await world.packs.verify(canonical.canonicalSha256, { ip: burst }));
  expect(answers.slice(0, 10).every((a) => !(a instanceof Refusal))).toBe(true);
  await expect(answers.at(-1)).toBeRateLimited();
}, storage);

scenario("IT-MCP-005 get_pack returns the full public view; the adopt snippet is a Preview until the engine ships", async (world) => {
  const pack = await world.packs.public("@acme/gcp", {
    versions: ["1.0.0", "1.1.0"],
    verification: { verified: true, verifiedDomain: "acme.com", sourceVerified: true },
    capabilities: ["guard"],
    preinstall: { guards: [{ name: "no-secrets", tool_calls: ["Bash"] }], new: ["guard:no-secrets"] },
  });
  await pack.version("1.0.0").seed({ status: "deprecated", reason: "use 1.1.0" });

  const view = (await pack.read()) as PackBody;
  expect(view.latest_eligible).toBe("1.1.0");
  expect(view.versions.map((v) => [v.version, v.status])).toEqual([["1.1.0", "active"], ["1.0.0", "deprecated"]]);
  expect(view.versions.find((v) => v.version === "1.0.0")?.reason).toBe("use 1.1.0");
  expect(view.version).toMatchObject({
    version: "1.1.0",
    verification: { verified: true, verified_domain: "acme.com", source_verified: true },
    provenance: { source: "oidc", source_verified: true },
    preinstall: { guards: [{ name: "no-secrets", tool_calls: ["Bash"] }], new: ["guard:no-secrets"] },
    capabilities: ["guard"],
    score: { total: expect.any(Number) },
    inventory: { skills: { count: 0 }, rules: { count: 0 } },
  });
  expect(Object.keys(view.version ?? {})).not.toContain("files");
  expect(Object.keys(view.version ?? {})).not.toContain("contents");
}, storage);

scenario("IT-PAGE-002 The public view shows verification facts, capabilities, source, hashes and the report", async (world) => {
  const trusted = await world.packs.public("@acme/gcp", {
    versions: ["1.1.0"],
    verification: { verified: true, verifiedDomain: "acme.com", sourceVerified: true },
    capabilities: ["guard"],
    preinstall: { guards: [{ name: "no-secrets", tool_calls: ["Bash"] }], new: ["guard:no-secrets"] },
  });
  const upload = await world.packs.public("@acme/notes");

  const t = await trusted.version("1.1.0").detail();
  const stored = await trusted.stored("1.1.0");
  expect(t).toMatchObject({
    verification: { verified: true, verified_domain: "acme.com", source_verified: true },
    provenance: { source: "oidc", source_verified: true, repository: "acme/packs", commit: "b".repeat(40) },
    hashes: { canonical_sha256: stored.canonicalSha256, upload_sha256: stored.uploadSha256 },
    validated_at: expect.any(String),
    rules_version: "2026.10.1",
    preinstall: { new: ["guard:no-secrets"] },
    report_published: true,
  });
  const u = await upload.version("1.0.0").detail();
  expect(u.provenance).toEqual({ source: "upload", source_verified: false });
  expect(u.verification.source_verified).toBe(false);
}, storage);
