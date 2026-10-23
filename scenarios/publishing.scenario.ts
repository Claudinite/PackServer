import { accepted, archiveBytes, expect, Refusal, scenario, type World } from "@packserver/test-world";

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

  const par = world.ci.repo("par/packs", { id: 710, ownerId: 7101 });
  await world.ci.seedTrustedPublisher({ pack: "@par/pack", repo: par, workflow: WORKFLOW, environment: "release", path: "packs/pack" });
  const parRun = world.ci.workflow({ repo: par, environment: "release", ref: "refs/tags/pack/1.0.0" });
  await world.ci.staging.fill(parRun, "@par/pack", 47);
  const racers = await Promise.all([1, 2, 3, 4].map(async (n) => accepted(await parRun.exchange("@par/pack", `9.0.${n}`))));
  const outcomes = await Promise.all(racers.map((racer) => racer.presign(3 * MiB)));
  expect(outcomes.filter((outcome) => !(outcome instanceof Refusal))).toHaveLength(1);
  for (const outcome of outcomes.filter((o) => o instanceof Refusal)) expect(outcome).toBeRefused("quota");

  const big = world.ci.repo("big/packs", { id: 700, ownerId: 7001 });
  await world.ci.seedTrustedPublisher({ pack: "@big/pack", repo: big, workflow: WORKFLOW, environment: "release", path: "packs/pack" });
  const bigRun = world.ci.workflow({ repo: big, environment: "release", ref: "refs/tags/pack/1.0.0" });

  await world.ci.staging.fill(bigRun, "@big/pack", 49, { confirm: false });
  await world.clock.advance("16m");

  const over = accepted(await bigRun.exchange("@big/pack", "9.0.0"));
  await expect(over.presign(2 * MiB)).toBeRefused("quota");
  expect(accepted(await over.upload(archiveBytes(MiB)))).toMatchObject({ sizeBytes: MiB });
});
