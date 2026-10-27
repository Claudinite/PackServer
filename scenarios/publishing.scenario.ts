import { accepted, archiveBytes, expect, Refusal, scenario, type PackBody, type World } from "@packserver/test-world";

const WORKFLOW = ".github/workflows/publish.yml";
const MiB = 1024 * 1024;

/** The registration of IT-PUB-003: `acme/packs`, environment `release`, the default ref patterns and event set. */
async function registerGcp(world: World, pack = "@acme/gcp") {
  const repo = world.ci.repo("acme/packs", { id: 5150, ownerId: 1001 });
  await world.ci.seedTrustedPublisher({ pack, repo, workflow: WORKFLOW, environment: "release", path: "packs/gcp" });
  return repo;
}

scenario("IT-PUB-003 A matching OIDC token yields a 15-minute pack-scoped upload credential; ref, event and job are checked", async (world) => {
  const repo = await registerGcp(world);
  await world.ci.seedTrustedPublisher({ pack: "@acme/bare", repo, workflow: WORKFLOW, path: "packs/bare" });
  const run = world.ci.workflow({ repo, environment: "release", ref: "refs/tags/gcp/1.0.0", job: "publish" });

  const early = accepted(await run.exchange("@acme/gcp", "1.0.0"));
  const late = accepted(await run.exchange("@acme/gcp", "1.0.1"));
  const stray = accepted(await run.exchange("@acme/gcp", "1.0.2"));
  await expect(stray.presign(MiB, { pack: "@acme/other" })).toBeRefused("forbidden");

  await world.clock.advance("14m");
  expect(accepted(await early.upload(archiveBytes(2048)))).toMatchObject({ sizeBytes: 2048 });
  await world.clock.advance("1m1s");
  await expect(late.upload(archiveBytes(2048))).toBeRefused("oidc.invalid");

  const branch = world.ci.workflow({ repo, environment: "release", ref: "refs/heads/feature" });
  await expect(branch.exchange("@acme/gcp", "1.1.0")).toBeRefusedWithClaimDiff("workflow");
  const scheduled = world.ci.workflow({ repo, environment: "release", event: "schedule" });
  await expect(scheduled.exchange("@acme/gcp", "1.1.0")).toBeRefusedWithClaimDiff("workflow");
  const taskJob = world.ci.workflow({ repo, environment: "release", job: "task" });
  await expect(taskJob.exchange("@acme/gcp", "1.1.0")).toBeRefusedWithClaimDiff("workflow");

  const unprotected = world.ci.workflow({ repo, ref: "refs/tags/bare/1.0.0", refProtected: false });
  await expect(unprotected.exchange("@acme/bare", "1.0.0")).toBeRefusedWithClaimDiff("workflow");
  const protectedRun = world.ci.workflow({ repo, ref: "refs/tags/bare/1.0.0", refProtected: true });
  accepted(await protectedRun.exchange("@acme/bare", "1.0.0"));
});

scenario("IT-PUB-004 Fork, pull_request*, workflow_run, off-pattern or mismatched tokens are refused with a claim diff", async (world) => {
  const repo = await registerGcp(world);
  const fork = world.ci.repo("mallory/packs", { id: 900, ownerId: 9001 });
  const run = (over: Parameters<typeof world.ci.workflow>[0]) => world.ci.workflow({ environment: "release", ref: "refs/tags/gcp/1.0.0", ...over });

  await expect(run({ repo: fork, forkOf: repo }).exchange("@acme/gcp", "1.0.0")).toBeRefusedWithClaimDiff("fork");
  await expect(run({ repo, event: "pull_request" }).exchange("@acme/gcp", "1.0.0")).toBeRefusedWithClaimDiff("fork");
  await expect(run({ repo, event: "pull_request_target" }).exchange("@acme/gcp", "1.0.0")).toBeRefusedWithClaimDiff("fork");
  await expect(run({ repo, event: "workflow_run" }).exchange("@acme/gcp", "1.0.0")).toBeRefusedWithClaimDiff("fork");
  await expect(run({ repo, workflowFile: ".github/workflows/other.yml" }).exchange("@acme/gcp", "1.0.0")).toBeRefusedWithClaimDiff("workflow");
  await expect(world.ci.workflow({ repo, ref: "refs/tags/gcp/1.0.0" }).exchange("@acme/gcp", "1.0.0")).toBeRefused("oidc.environment");
  await expect(run({ repo, ref: "refs/heads/feature" }).exchange("@acme/gcp", "1.0.0")).toBeRefusedWithClaimDiff("workflow");
  await expect(run({ repo, event: "schedule" }).exchange("@acme/gcp", "1.0.0")).toBeRefused("oidc.workflow");
  expect(await world.ci.staging.objects("acme")).toEqual([]);

  const registered = accepted(await run({ repo }).exchange("@acme/gcp", "1.0.0"));
  expect(accepted(await registered.upload(archiveBytes(1024)))).toMatchObject({ sizeBytes: 1024 });
});

scenario("IT-PUB-005 A trusted publisher survives a rename but not a transfer or a re-creation", async (world) => {
  const repo = await registerGcp(world);
  const exchange = (r: typeof repo, version: string) => world.ci.workflow({ repo: r, environment: "release", ref: "refs/tags/gcp/1.0.0" }).exchange("@acme/gcp", version);

  repo.rename("acme/packs-v2");
  accepted(await exchange(repo, "1.0.0"));

  repo.transferTo({ slug: "newco", id: 2002 });
  await expect(exchange(repo, "1.0.1")).toBeRefusedWithClaimDiff("fork");

  const recreated = world.ci.repo("acme/packs", { id: 501, ownerId: 1001 });
  await expect(exchange(recreated, "1.0.2")).toBeRefusedWithClaimDiff("fork");
});

scenario("IT-PUB-029 An invalid OIDC token is refused regardless of its claims; JWKS rotation is followed", async (world) => {
  const repo = await registerGcp(world);
  const run = world.ci.workflow({ repo, environment: "release", ref: "refs/tags/gcp/1.0.0" });
  const exchangeWith = async (token: string) => run.exchange("@acme/gcp", "1.0.0", { token });
  const nowS = Math.floor((await world.clock.now()).getTime() / 1000);

  await expect(exchangeWith(await run.oidcToken({ aud: "evil.example" }))).toBeRefused("oidc.invalid");
  await expect(exchangeWith(await run.oidcToken({ foreignIssuer: true }))).toBeRefused("oidc.invalid");
  await expect(exchangeWith(await run.oidcToken({ iat: nowS - 900, nbf: nowS - 900, exp: nowS - 600 }))).toBeRefused("oidc.invalid");
  await expect(exchangeWith(await run.oidcToken({ nbf: nowS + 3600 }))).toBeRefused("oidc.invalid");
  await expect(exchangeWith(await run.oidcToken({ alg: "none" }))).toBeRefused("oidc.invalid");
  await expect(exchangeWith(await run.oidcToken({ alg: "HS256" }))).toBeRefused("oidc.invalid");
  await expect(exchangeWith(await world.ci.issuer.mintUnpublished({}))).toBeRefused("oidc.invalid");

  const [keyA] = await world.ci.issuer.keyIds();
  accepted(await exchangeWith(await run.oidcToken()));
  const signedByA = await run.oidcToken({ kid: keyA });
  const keyB = await world.ci.issuer.addKey();
  const signedByB = await run.oidcToken({ kid: keyB });
  world.ci.issuer.removeKey(keyA!);
  await world.clock.advance("61s");

  accepted(await exchangeWith(signedByB));
  await expect(exchangeWith(signedByA)).toBeRefused("oidc.invalid");
});

scenario("IT-PUB-030 The upload credential is bound, single-use, size-capped and cannot overwrite", async (world) => {
  const repo = await registerGcp(world);
  const run = world.ci.workflow({ repo, environment: "release", ref: "refs/tags/gcp/1.0.0" });
  const archive = archiveBytes(MiB);

  const first = accepted(await run.exchange("@acme/gcp", "1.0.0"));
  const firstUpload = accepted(await first.presign(archive.byteLength));
  expect(firstUpload.key).toBe(`staging/${world.alias("acme")}/gcp/1.0.0/${first.id}.tar.zst`);
  await world.ci.put(firstUpload, archive);
  expect(accepted(await first.complete()).key).toBe(firstUpload.key);
  expect(await world.ci.staging.objects("acme")).toEqual([{ key: firstUpload.key, size: archive.byteLength }]);
  const original = await world.ci.staging.sha256(firstUpload.key);
  await expect(first.presign(archive.byteLength)).toBeRefused("oidc.invalid");
  await expect(world.ci.put(firstUpload, archiveBytes(MiB, 2))).toBeRefused("exists");

  const second = accepted(await run.exchange("@acme/gcp", "1.0.0"));
  const secondUpload = accepted(await second.presign(archive.byteLength));
  expect(secondUpload.key).not.toBe(firstUpload.key);
  await expect(world.ci.put(secondUpload, archiveBytes(MiB, 2), { url: secondUpload.url.replace(secondUpload.key, firstUpload.key) })).toBeRefused("signature");
  expect(await world.ci.staging.sha256(firstUpload.key)).toBe(original);

  const third = accepted(await run.exchange("@acme/gcp", "1.0.1"));
  const oversize = accepted(await third.presign(3 * MiB));
  await expect(world.ci.put(oversize, archiveBytes(3 * MiB + 1))).toBeRefused("signature");
  const fourth = accepted(await run.exchange("@acme/gcp", "1.0.2"));
  await expect(fourth.presign(3 * MiB + 1)).toBeRefused("quota");

  const fifth = accepted(await run.exchange("@acme/gcp", "1.0.3"));
  const multipart = accepted(await fifth.presign(MiB));
  await expect(world.ci.startMultipart(multipart)).toBeRefused("signature");

  const sixth = accepted(await run.exchange("@acme/gcp", "1.0.4"));
  const sixthUpload = accepted(await sixth.presign(archive.byteLength));
  await world.ci.put(sixthUpload, archive);
  await world.clock.advance("16m");
  expect(accepted(await sixth.complete()).key).toBe(sixthUpload.key);

  const big = world.ci.repo("big/packs", { id: 700, ownerId: 7001 });
  await world.ci.seedTrustedPublisher({ pack: "@big/pack", repo: big, workflow: WORKFLOW, environment: "release", path: "packs/pack" });
  const bigRun = world.ci.workflow({ repo: big, environment: "release", ref: "refs/tags/pack/1.0.0" });

  await world.ci.staging.fill(bigRun, "@big/pack", 47, { confirm: false });
  await world.clock.advance("16m");

  const racers = await Promise.all([1, 2, 3, 4].map(async (n) => accepted(await bigRun.exchange("@big/pack", `9.0.${n}`))));
  const raced = await Promise.all(racers.map((racer) => racer.presign(3 * MiB)));
  expect(raced.filter((outcome) => !(outcome instanceof Refusal))).toHaveLength(1);
  for (const outcome of raced.filter((o) => o instanceof Refusal)) expect(outcome).toBeRefused("quota");

  const over = accepted(await bigRun.exchange("@big/pack", "9.1.0"));
  await expect(over.presign(MiB)).toBeRefused("quota");
});

scenario("IT-PUB-017 Versions are immutable; re-publishing a version is an error", async (world) => {
  const z = await world.publishers.create({ handle: "z" });
  const original = world.archive("gcp", { version: "1.0.0" });
  const other = world.archive("gcp", { version: "1.0.0", files: { "README.md": "# different bytes\n" } });
  expect(other.sha256).not.toBe(original.sha256);

  const first = await z.publish(original).as("@z/tool@1.0.0");
  const staged = await world.ci.staging.objects("z");
  expect(staged).toHaveLength(1);

  await expect(z.publish(other).as("@z/tool@1.0.0")).toBeRefused("exists");
  expect(await world.ci.staging.objects("z")).toEqual(staged);

  expect(await first.sha256()).toBe(original.sha256);
  expect(await first.sha256()).toBe(original.sha256);
});

scenario("IT-PUB-026 20 versions per pack a day; 5 new packs per scope a day, 20 for a Verified Publisher", async (world) => {
  await world.pauseValidation();
  const versions = await world.publishers.create({ handle: "vers" });
  const plain = await world.publishers.create({ handle: "plain" });
  const verified = await world.publishers.create({ handle: "vp", verified: true });
  const racer = await world.publishers.create({ handle: "race" });

  // Each scope takes its publishes in waves of five: concurrent enough to keep the run well inside the
  // scenario timeout under load, few enough that no start waits long for its scope's publish lock.
  const inWaves = async (count: number, publish: (n: number) => Promise<unknown>) => {
    for (let first = 0; first < count; first += 5) await Promise.all(Array.from({ length: Math.min(5, count - first) }, (_, k) => publish(first + k)));
  };
  const day = await Promise.all([
    inWaves(20, (n) => versions.publish(world.archive("gcp", { version: `1.0.${n}` })).as(`@vers/tool@1.0.${n}`)),
    inWaves(5, (n) => plain.publish(world.archive("gcp", { version: `1.0.${n + 1}` })).as(`@plain/pack${n + 1}@1.0.0`)),
    inWaves(20, (n) => verified.publish(world.archive("gcp", { version: `1.0.${n + 1}` })).as(`@vp/pack${n + 1}@1.0.0`)),
  ]);
  expect(day).toHaveLength(3);
  await expect(versions.publish(world.archive("gcp", { version: "1.0.20" })).as("@vers/tool@1.0.20")).toBeRefusedSaying("a day");
  await expect(plain.publish(world.archive("gcp")).as("@plain/pack6@1.0.0")).toBeRefusedSaying("a day");
  await expect(verified.publish(world.archive("gcp")).as("@vp/pack21@1.0.0")).toBeRefusedSaying("a day");

  await world.clock.advance("24h1m");
  await versions.publish(world.archive("gcp", { version: "1.0.20" })).as("@vers/tool@1.0.20");
  await plain.publish(world.archive("gcp")).as("@plain/pack6@1.0.0");
  await verified.publish(world.archive("gcp")).as("@vp/pack21@1.0.0");

  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, (_, n) => racer.publish(world.archive("gcp", { version: `2.0.${n}` })).as(`@race/pack${n}@1.0.0`)),
  );
  expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(5);
  for (const refused of attempts.filter((a) => a.status === "rejected")) await expect(Promise.reject((refused as PromiseRejectedResult).reason)).toBeRefused("quota");
});

scenario("IT-PUB-027 Concurrent publishes of one version yield one version and one new-pack count", async (world) => {
  await world.pauseValidation();
  const z = await world.publishers.create({ handle: "z" });
  const y = await world.publishers.create({ handle: "y" });
  // Promotion does not exist yet, so a version is "one" when exactly one publish was admitted for it;
  // once promotion lands, tighten this to read the promoted versions from the registry and assert that
  // the coordinator promoted the second scope's two versions one after the other.
  const outcomes = (attempts: PromiseSettledResult<unknown>[]) => ({
    won: attempts.filter((a) => a.status === "fulfilled").length,
    lost: attempts.filter((a) => a.status === "rejected") as PromiseRejectedResult[],
  });

  for (let n = 1; n <= 4; n++) await z.publish(world.archive("gcp", { version: `0.0.${n}` })).as(`@z/old${n}@1.0.0`);
  const racing = outcomes(
    await Promise.allSettled(Array.from({ length: 5 }, (_, n) => z.publish(world.archive("gcp", { files: { "README.md": `# racer ${n}\n` } })).as("@z/new@1.0.0"))),
  );
  expect(racing.won).toBe(1);
  for (const lost of racing.lost) await expect(Promise.reject(lost.reason)).toBeRefused("exists");
  const counted = await world.driver.publishStorage!.sql("select count(*) as n from validation_runs where pack_name = 'new' and counted_new_pack = 1");
  expect(counted[0]!.n).toBe(1);
  await expect(z.publish(world.archive("gcp")).as("@z/sixth@1.0.0")).toBeRefused("quota");

  await y.publish(world.archive("gcp")).as("@y/lib@1.0.0");
  const attempts = await Promise.allSettled(
    [1, 1, 1, 2, 2].map((minor, n) => y.publish(world.archive("gcp", { files: { "README.md": `# racer ${n}\n` } })).as(`@y/lib@1.${minor}.0`)),
  );
  const settled = outcomes(attempts);
  expect(settled.won).toBe(2);
  for (const lost of settled.lost) await expect(Promise.reject(lost.reason)).toBeRefused("exists");
  await y.publish(world.archive("gcp")).as("@y/lib@1.3.0");
});

scenario("IT-VAL-002 Hash mismatch, oversize or non-zstd fail before any sandbox starts", async (world) => {
  const v = await world.publishers.create({ handle: "v" });
  const valid = world.archive("gcp");

  await expect(v.publish(world.archive("gcp", { padTo: 3 * MiB + 1 })).as("@v/big@1.0.0")).toBeRefused("quota");
  expect(await world.ci.staging.objects("v")).toEqual([]);

  const mismatch = await v.publish(valid).as("@v/lie@1.0.0", { declaredSha256: "0".repeat(64) });
  expect(await mismatch.run.verdict()).toBe("fail");
  expect(await mismatch.run.reason()).toBe("integrity.sha256_mismatch");

  const gzip = await v.publish(world.archive("gcp", { format: "gzip" })).as("@v/gz@1.0.0");
  expect(await gzip.run.verdict()).toBe("fail");
  expect(await gzip.run.reason()).toBe("integrity.not_zstd");

  for (const run of [mismatch.run, gzip.run]) {
    const steps = await run.milestones();
    expect(steps.map((m) => `${m.step}:${m.outcome}`)).toEqual(["admission:ok", "integrity:fail"]);
  }
  expect((await world.recorder.invocations()).filter((i) => /sandbox/i.test(i.target))).toEqual([]);

  const exact = await v.publish(world.archive("gcp", { padTo: 3 * MiB })).as("@v/exact@1.0.0");
  const steps = await exact.run.milestones();
  expect(steps.slice(0, 2).map((m) => `${m.step}:${m.outcome}`)).toEqual(["admission:ok", "integrity:ok"]);
});

scenario("IT-PUB-023 Deprecate a version with a public reason", async (world) => {
  await world.access.seedRegistryKeys();
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const { owner } = await world.lifecycle.staff(pack);
  const before = await world.registry.serial(pack);

  await expect(pack.version("1.0.0").deprecate("superseded by 1.1", { by: owner, assertion: "none" })).toBeRefused("step-up");
  expect(await pack.version("1.0.0").status()).toBe("active");
  await pack.version("1.0.0").deprecate("superseded by 1.1", { by: owner });

  const signed = await world.registry.indexes(pack, { newerThan: before });
  expect(signed.scope.verifies).toBe(true);
  expect(signed.scope.document.packs[0]!.versions[0]).toMatchObject({ version: "1.0.0", status: "deprecated", reason: "superseded by 1.1" });
  expect(signed.scope.document.packs[0]!.latest_eligible).toBe("1.0.0");
  expect(await pack.read({ version: "1.0.0" })).toMatchObject({ outcome: "found", version: { status: "deprecated", reason: "superseded by 1.1" } });
  expect(await pack.version("1.0.0").sha256()).toBe((await pack.stored("1.0.0")).canonicalSha256);
  expect(await world.lifecycle.objects(pack, "1.0.0")).not.toEqual([]);
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-PUB-024 Hard delete only within 72 h and with zero fetches; the number stays listed as removed", async (world) => {
  await world.access.seedRegistryKeys();
  const ann = await world.publishers.create({ handle: "ann" });
  await ann.orgs.create("acme");
  const old = await world.packs.public("@acme/old", { versions: ["1.0.0"] });
  await world.clock.advance("72h");
  const fresh = await world.packs.public("@acme/fresh", { versions: ["1.0.0", "1.1.0"] });
  await world.clock.advance("1h");
  await ann.signIn();
  await world.lifecycle.recordFetch(fresh, "1.1.0");

  expect(await world.lifecycle.offer(fresh, ann)).toMatchObject({
    versions: [{ version: "1.0.0", deletable: true }, { version: "1.1.0", deletable: false }],
  });
  expect(await world.lifecycle.offer(old, ann)).toMatchObject({ versions: [{ version: "1.0.0", deletable: false }] });
  await expect(old.version("1.0.0").delete({ by: ann })).toBeRefused("forbidden");
  await expect(fresh.version("1.1.0").delete({ by: ann })).toBeRefused("forbidden");
  await expect(fresh.version("1.0.0").delete({ by: ann, assertion: "none" })).toBeRefused("step-up");
  expect(await fresh.version("1.0.0").status()).toBe("active");

  const before = await world.registry.serial(fresh);
  await fresh.version("1.0.0").delete({ by: ann });
  await world.lifecycle.removedFromStorage(fresh, "1.0.0");
  const listed = (await world.registry.indexes(fresh, { newerThan: before })).scope.document.packs.find((p) => world.unalias(p.name) === "@acme/fresh")!;
  expect(listed.versions.find((v) => v.version === "1.0.0")).toEqual(expect.objectContaining({ status: "removed" }));
  expect(listed.versions.find((v) => v.version === "1.0.0")).not.toHaveProperty("sha256");
  expect(listed.latest_eligible).toBe("1.1.0");
  expect(await world.lifecycle.objects(fresh, "1.0.0")).toEqual([]);
  expect(await world.lifecycle.objects(fresh, "1.1.0")).not.toEqual([]);
  expect(world.lifecycle.purged().filter((url) => url.includes("/@acme/fresh/1.0.0/")).length).toBeGreaterThan(0);
  expect(await fresh.version("1.0.0").status()).toBe("removed");
  await expect(ann.publish(world.archive("gcp")).as("@acme/fresh@1.0.0")).toBeRefused("exists");

  const solo = await world.packs.public("@acme/solo", { versions: ["1.0.0"] });
  await solo.version("1.0.0").delete({ by: ann });
  await expect(ann.publish(world.archive("gcp")).as("@acme/solo@2.0.0")).toBeRefused("exists");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-PUB-025 Private packs delete any time with a 7-day soft window", async (world) => {
  await world.access.seedRegistryKeys();
  const ann = await world.publishers.create({ handle: "ann" });
  await ann.orgs.create("acme");
  const secret = await world.packs.public("@acme/secret", { visibility: "private", versions: ["1.0.0"] });
  await world.clock.advance("200d");
  await ann.signIn();
  await world.lifecycle.recordFetch(secret, "1.0.0");

  await expect(world.lifecycle.deletePack(secret, { by: ann, assertion: "none" })).toBeRefused("step-up");
  expect(await world.lifecycle.offer(secret, ann)).toMatchObject({ deleted: false });
  await world.lifecycle.deletePack(secret, { by: ann });
  expect(await world.lifecycle.offer(secret, ann)).toMatchObject({ deleted: true });

  await world.clock.advance("6d");
  await ann.signIn();
  await world.lifecycle.restorePack(secret, { by: ann });
  expect(await world.lifecycle.offer(secret, ann)).toMatchObject({ deleted: false });
  expect(await world.lifecycle.archiveKept(secret, "1.0.0")).toBe(true);

  await world.lifecycle.deletePack(secret, { by: ann });
  await world.clock.advance("6d");
  await world.lifecycle.sweep(secret);
  expect(await world.lifecycle.archiveKept(secret, "1.0.0")).toBe(true);
  await world.clock.advance("1d1h");
  await ann.signIn();
  await world.lifecycle.sweep(secret);
  await world.lifecycle.removedFromStorage(secret, "1.0.0");
  expect(await world.lifecycle.archiveKept(secret, "1.0.0")).toBe(false);
  await expect(world.lifecycle.restorePack(secret, { by: ann })).toBeRefused("forbidden");
  await expect(ann.publish(world.archive("gcp")).as("@acme/secret@2.0.0")).toBeRefused("exists");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-MOD-011 Yank moves latest and leaves search; un-yank is logged", async (world) => {
  await world.access.seedRegistryKeys();
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0", "1.2.0"] });
  const { owner, maintainer } = await world.lifecycle.staff(pack);
  const before = await world.registry.serial(pack);

  await expect(pack.version("1.2.0").yank({ reason: "leaks tokens", security: true, by: maintainer, assertion: "none" })).toBeRefused("step-up");
  expect(await pack.version("1.2.0").status()).toBe("active");
  await pack.version("1.2.0").yank({ reason: "leaks tokens", security: true, by: maintainer });

  const signed = await world.registry.indexes(pack, { newerThan: before });
  const entry = signed.scope.document.packs[0]!;
  expect(entry.latest_eligible).toBe("1.1.0");
  expect(entry.versions.find((v) => v.version === "1.2.0")).toMatchObject({ status: "yanked", reason: "leaks tokens", security: "leaks tokens" });
  const view = (await pack.read()) as PackBody;
  expect(view.latest_eligible).toBe("1.1.0");
  expect(view.versions.find((v) => v.version === "1.2.0")).toMatchObject({ yanked: true, reason: "leaks tokens" });

  const restored = await world.registry.serial(pack);
  await pack.version("1.2.0").unyank({ by: owner });
  expect((await world.registry.indexes(pack, { newerThan: restored })).scope.document.packs[0]!.latest_eligible).toBe("1.2.0");
  expect((await owner.account.history()).map((e) => e.action)).toContain("version.unyanked");
  expect((await maintainer.account.history()).map((e) => e.action)).toContain("version.yanked");
  const held = await world.packs.public("@acme/held", { versions: ["1.0.0"] });
  await held.version("1.0.0").seed({ status: "yanked", reason: "Removed by PackServer: malware" });
  await expect(held.version("1.0.0").yank({ reason: "my own reason", by: maintainer })).toBeRefused("forbidden");
  await expect(held.version("1.0.0").unyank({ by: owner })).toBeRefused("forbidden");
  await expect(held.version("1.0.0").delete({ by: owner })).toBeRefused("forbidden");
  await expect(pack.version("1.0.0").yank({ reason: "Removed by PackServer: looks official", by: maintainer })).toBeRefused("forbidden");
  await expect(pack.version("1.0.0").deprecate("Removed by PackServer: looks official", { by: maintainer })).toBeRefused("forbidden");
  expect(await held.version("1.0.0").status()).toBe("yanked");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-MOD-012 Yanking the only version leaves the pack listed as unavailable", async (world) => {
  await world.access.seedRegistryKeys();
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  const { owner } = await world.lifecycle.staff(pack);
  await world.search.list(pack, { pitch: "Cloud tools" });
  const before = await world.registry.serial(pack);

  await pack.version("1.0.0").yank({ reason: "published by mistake", by: owner });

  const entry = (await world.registry.indexes(pack, { newerThan: before })).scope.document.packs[0]!;
  expect(entry.latest_eligible).toBeNull();
  expect(entry.versions).toHaveLength(1);
  const page = await pack.page("overview");
  expect(page).not.toBeNotFound();
  expect((page as { statusLines: string[] }).statusLines.join(" ")).toContain("No available versions: published by mistake");
}, { needs: ["fakes", "clock", "storage"] });

scenario("IT-MOD-013 Yank and deprecate notify stargazers and open reporters; nothing to GitHub", async (world) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0", "1.1.0"] });
  const { owner } = await world.lifecycle.staff(pack);
  const [s, t, r] = [await world.users.create(), await world.users.create(), await world.users.create()];
  for (const person of [s, t, r]) await person.signIn();
  await world.community.star(s, pack);
  await world.community.star(t, pack);
  await world.lifecycle.digest(s, true);
  await world.reports.file(r, pack, { kind: "bug", version: "1.0.0", title: "Crashes on adopt" });

  await pack.version("1.0.0").deprecate("use the newer release", { by: owner });
  await pack.version("1.1.0").yank({ reason: "breaks the update task", by: owner });
  await world.lifecycle.deliver();

  const heard = (person: typeof s) => world.mail.inbox(person).all().filter((m) => /withdrawn|deprecated|yanked/.test(m.subject));
  expect(heard(s)).toHaveLength(1);
  expect(heard(s)[0]!.text).toContain("1.0.0");
  expect(heard(s)[0]!.text).toContain("1.1.0");
  expect(heard(r)).toHaveLength(1);
  expect(heard(r)[0]!.text).toContain("1.0.0");
  expect(heard(r)[0]!.text).not.toContain("1.1.0");
  expect(heard(t)).toEqual([]);
  expect(await world.github.writes()).toEqual([]);
}, { needs: ["fakes", "clock", "storage"] });
