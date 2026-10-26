import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts, World } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "storage"] };
const PROOF_NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "reset"] };
const COMMIT_FILES = {
  "packs/gcp/pack.json": '{"name":"gcp"}',
  "packs/gcp/bin/run.sh": { content: "#!/bin/sh\n", executable: true },
  "packs/gcp/README.md": "# gcp\n",
  "docs/unrelated.md": "not in the pack",
};

/** Every scenario that touches GitHub ends by proving the registry wrote nothing to it. */
async function expectNoWrites(world: World): Promise<void> {
  expect(await world.github.writes()).toEqual([]);
}

scenario(
  "IT-PUB-028 Unsigned or unknown GitHub webhooks are ignored",
  async (world) => {
    const g = world.github;
    const acme = await g.installApp("acme", { installationId: 101 });
    expect((await g.issue("acme/packs", 1))).toBeNull();

    const unsigned = await g.webhook("installation", { signature: "missing", payload: { action: "deleted", installation: { id: acme.id } } });
    const wrong = await g.webhook("installation", { signature: "wrong", payload: { action: "deleted", installation: { id: acme.id } } });
    const unknown = await g.webhook("installation", { installation: "unknown" });
    const unknownIssue = await g.webhook("issues", { installation: 31337 });
    for (const delivery of [unsigned, wrong, unknown, unknownIssue]) expect(delivery).toBeIgnored();

    // The answer never says which check failed.
    const answers = [unsigned, wrong, unknown, unknownIssue].map((d) => ({ status: (d as { status: number }).status, text: (d as { text: string }).text }));
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);

    // Nothing happened: the known installation is untouched and the unknown one was never recorded.
    expect(await g.installation(acme.id)).toMatchObject({ status: "active", uninstalled_at: null });
    expect(await g.installation(99_999)).toBeNull();
    expect(await g.issue("acme/packs", 1)).toBeNull();

    // A correctly signed `issues` webhook from a known installation moves the issue's state.
    expect(await g.issueState("acme/packs", 7, "closed")).toMatchObject({ result: "applied" });
    expect(await g.issue("acme/packs", 7)).toMatchObject({ state: "closed" });
    await expectNoWrites(world);
  },
  NEEDS,
);

scenario(
  "IT-SCOPE-008 GitHub org proof by App install or org-admin sign-in",
  async (world) => {
    const g = world.github;
    const acme = await g.installApp("acme", { by: "owner-g", installationId: 201 });
    const gamma = await g.installApp("gamma", { by: "member-n", type: "Organization", installationId: 202, repositories: "selected" });

    // The registry records who installed on which account; whether that person owns the org is the proof hook's call.
    expect(await g.installation(acme.id)).toMatchObject({ account_login: "acme", account_type: "Organization", sender_login: "owner-g", status: "active", repository_selection: "all" });
    expect(await g.installation(gamma.id)).toMatchObject({ account_login: "gamma", sender_login: "member-n", repository_selection: "selected" });

    expect(await g.webhook("installation_repositories", { installation: acme.id })).toMatchObject({ result: "applied" });
    expect(await g.installation(acme.id)).toMatchObject({ repository_selection: "selected" });
    {
      const acmeGh = world.alias("acmegh");
      const betaGh = world.alias("betagh");
      const gammaGh = world.alias("gammagh");
      const g = await world.publishers.create({ handle: "g", githubOrgs: [{ id: 7001, login: acmeGh, role: "admin" }] });
      const s = await world.publishers.create({ handle: "s", githubOrgs: [{ id: 7002, login: betaGh, role: "admin" }] });
      const n = await world.publishers.create({ handle: "n", githubOrgs: [{ id: 7003, login: gammaGh, role: "member" }] });
      const acme = await g.orgs.create("acme");
      const beta = await s.orgs.create("beta");
      const gamma = await n.orgs.create("gamma");

      await world.github.installApp(acmeGh, { by: world.alias("g") });
      await world.github.installApp(gammaGh, { by: world.alias("n") });

      await expect(acme.verifyGitHub(acmeGh, "app")).resolves.toMatchObject({ org: "acmegh", method: "app" });
      await expect(beta.verifyGitHub(betaGh, "admin")).resolves.toMatchObject({ org: "betagh", method: "admin" });
      await expect(gamma.verifyGitHub(gammaGh, "app")).toBeRefusedSaying("not an owner");
      await expect(gamma.verifyGitHub(gammaGh, "admin")).toBeRefusedSaying("owner");
      await expect(beta.verifyGitHub(acmeGh, "admin")).toBeRefusedSaying("already holds");

      await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedGithubOrg: "acmegh", mark: { kind: "github", text: `● github.com/acmegh` } });
      await expect(world.profiles.profile(beta)).resolves.toMatchObject({ verifiedGithubOrg: "betagh" });
      await expect(world.profiles.profile(gamma)).resolves.toMatchObject({ verifiedGithubOrg: null, mark: { kind: "unproven" } });
      await expect(acme.verifyGitHub(acmeGh, "app", { assertion: "none" })).toBeRefused("step-up");
      expect(await world.github.writes()).toEqual([]);
    }
    await expectNoWrites(world);
  },
  PROOF_NEEDS,
);

scenario(
  "IT-SCOPE-009 App uninstall revokes the proof after 7 days with an alert",
  async (world) => {
    const g = world.github;
    const acme = await g.installApp("acme", { installationId: 301 });
    expect(await g.installation(acme.id)).toMatchObject({ status: "active", uninstalled_at: null });

    expect(await g.uninstallApp(acme)).toMatchObject({ result: "applied" });
    const gone = await g.installation(acme.id);
    expect(gone).toMatchObject({ status: "deleted" });
    expect(gone?.uninstalled_at).not.toBeNull();

    // A deleted installation is no longer known: its events change nothing.
    expect(await g.issueState("acme/packs", 1, "closed", { installationId: acme.id })).toBeIgnored();

    // Installing again inside the grace period clears the timer's input.
    await g.installApp("acme", { installationId: 301 });
    expect(await g.installation(acme.id)).toMatchObject({ status: "active", uninstalled_at: null });
    {
      const acmeGh = world.alias("acmegh");
      const g = await world.publishers.create({ handle: "g", githubOrgs: [{ id: 7001, login: acmeGh, role: "admin" }] });
      const acme = await g.orgs.create("acme");
      const installation = await world.github.installApp(acmeGh, { by: world.alias("g") });
      await acme.verifyGitHub(acmeGh, "app");

      await world.github.uninstallApp(installation);
      await world.cron.run("github-proof-lapse");
      expect(world.mail.inbox(g).all().filter((m) => m.subject.startsWith("GitHub App removed"))).toHaveLength(1);
      await expect(acme.verification()).resolves.toMatchObject({ github: { org: "acmegh", method: "app", endsAt: expect.any(String) } });

      await world.clock.advance("6d23h");
      await world.cron.run("github-proof-lapse");
      await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedGithubOrg: "acmegh" });

      await world.clock.advance("1h");
      await world.cron.run("github-proof-lapse");
      await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedGithubOrg: null, mark: { kind: "unproven" } });
      await expect(world.verifiedPublishers.reindexed(acme)).resolves.toContain("github_revoked");
      expect(world.mail.inbox(g).all().filter((m) => m.subject.startsWith("GitHub App removed"))).toHaveLength(1);
    }
    {
      const acmeGh = world.alias("secondgh");
      const h = await world.publishers.create({ handle: "h", githubOrgs: [{ id: 7009, login: acmeGh, role: "admin" }] });
      const acme = await h.orgs.create("second");
      const installation = await world.github.installApp(acmeGh, { by: world.alias("h"), installationId: 4201 });
      await acme.verifyGitHub(acmeGh, "app");

      await world.github.uninstallApp(installation);
      await world.cron.run("github-proof-lapse");
      await world.clock.advance("3d");
      await h.signIn();
      await world.github.installApp(acmeGh, { by: world.alias("h"), installationId: 4201 });
      await world.cron.run("github-proof-lapse");
      await expect(acme.verification()).resolves.toMatchObject({ github: { org: "secondgh", endsAt: null } });

      await world.clock.advance("30d");
      await world.cron.run("github-proof-lapse");
      await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedGithubOrg: "secondgh" });
    }
    await expectNoWrites(world);
  },
  PROOF_NEEDS,
);

scenario(
  "IT-MOD-001 Bug reports: pre-filled issue for a linked repo, in-site inbox otherwise (webhook half)",
  async (world) => {
    const g = world.github;
    await g.installApp("acme", { installationId: 101 });

    expect(await g.issueState("acme/packs", 12, "open")).toMatchObject({ result: "applied" });
    expect(await g.issue("acme/packs", 12)).toMatchObject({ state: "open" });
    expect(await g.issueState("acme/packs", 12, "closed")).toMatchObject({ result: "applied" });
    expect(await g.issue("acme/packs", 12)).toMatchObject({ state: "closed" });

    // An older delivery arriving late does not undo a newer state, and a redelivery changes nothing.
    await g.issueState("acme/packs", 12, "open", { updatedAt: "2026-10-22T00:00:00Z" });
    expect(await g.issue("acme/packs", 12)).toMatchObject({ state: "closed" });
    expect(await g.issueState("acme/packs", 13, "open", { deliveryId: "once" })).toMatchObject({ result: "applied" });
    expect(await g.issueState("acme/packs", 13, "closed", { deliveryId: "once" })).toMatchObject({ result: "duplicate" });
    expect(await g.issue("acme/packs", 13)).toMatchObject({ state: "open" });

    // Contrast: nothing is kept about a private repository's issues.
    await g.issueState("acme/secret-packs", 1, "open", { private: true });
    expect(await g.issue("acme/secret-packs", 1)).toBeNull();
    await expectNoWrites(world);
  },
  NEEDS,
);

scenario(
  "IT-PUB-006 Provenance comes from OIDC claims only, and a public source tree is verified (fetch half)",
  async (world) => {
    const g = world.github;
    const packs = g.repo("acme/packs");
    const commit = packs.commit(COMMIT_FILES);

    const found = await g.fetchTree({ repository: packs, commit, path: "packs/gcp" });
    expect(found).toMatchObject({ status: "found", file_count: 3 });
    const sameAgain = await g.fetchTree({ repository: packs, commit, path: "packs/gcp" });
    expect(sameAgain).toEqual(found);

    // One token minted per call; nothing but reads (the scenario ends by asserting no writes).
    expect(g.tokensMinted()).toBe(2);

    // A tree that differs from the first answers with a different hash for the validator to compare.
    const changed = packs.commit({ ...COMMIT_FILES, "packs/gcp/README.md": "# changed\n" });
    const other = await g.fetchTree({ repository: packs, commit: changed, path: "packs/gcp" });
    expect(other).toMatchObject({ status: "found" });
    expect(other).not.toEqual(found);

    // Contrast: a private repository is never read, and a path with nothing in it is not found.
    const secret = g.repo("acme/secret-packs", { private: true });
    const secretCommit = secret.commit({ "packs/gcp/pack.json": "{}" });
    const before = g.apiCalls().length;
    expect(await g.fetchTree({ repository: secret, commit: secretCommit, path: "packs/gcp" })).toEqual({ status: "not_found" });
    expect(g.apiCalls().slice(before).some((c) => c.path.includes("/git/"))).toBe(false);
    expect(await g.fetchTree({ repository: packs, commit, path: "packs/nothing" })).toEqual({ status: "not_found" });

    // GitHub failing is not an answer about the repository.
    g.failApi(503);
    expect(await g.fetchTree({ repository: packs, commit, path: "packs/gcp" })).toEqual({ status: "unreachable", retry_after_s: 7 });
    await expectNoWrites(world);
  },
  NEEDS,
);
