import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

// Each scenario starts from an empty world: a verified name makes confusable names unavailable to every later scenario.
const NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "reset"] };

scenario(
  "IT-SCOPE-010 Verified Publisher needs a proof, scope-wide MFA and a review; no subscription",
  async (world) => {
    const githubOrg = world.alias("fifthgh");
    const p1 = await world.publishers.create({ handle: "p1" });
    const p2 = await world.publishers.create({ handle: "p2" });
    const p3 = await world.publishers.create({ handle: "p3" });
    const p4 = await world.publishers.create({ handle: "p4" });
    const p5 = await world.publishers.create({ handle: "p5", githubOrgs: [{ id: 7005, login: githubOrg, role: "admin" }] });
    const noProof = await p1.orgs.create("noproof");
    const noMfa = await p2.orgs.create("nomfa");
    const noReview = await p3.orgs.create("noreview");
    const byDomain = await p4.orgs.create("bydomain");
    const byGitHub = await p5.orgs.create("bygithub");

    const proveDomain = async (org: typeof noMfa, domain: string) => {
      const challenge = await org.verifyDomain(domain);
      challenge.publishTxt();
      await org.checkDomain(challenge);
    };
    await proveDomain(noMfa, "nomfa.com");
    await proveDomain(noReview, "noreview.com");
    await proveDomain(byDomain, "bydomain.com");
    await byGitHub.verifyGitHub(githubOrg, "admin");
    for (const org of [noProof, noReview, byDomain, byGitHub]) await org.requireMfa("mfa");

    await expect(noProof.applyVerified()).toBeRefusedSaying("prove a domain or a GitHub organisation");
    await expect(noMfa.applyVerified()).toBeRefusedSaying("require MFA scope-wide");
    await expect(noReview.applyVerified()).resolves.toMatchObject({ state: "pending", basis: "domain" });
    await expect(noMfa.applyVerified({ assertion: "none" })).toBeRefused("step-up");
    await byDomain.applyVerified();
    await byGitHub.applyVerified();

    await world.verifiedPublishers.approve(byDomain);
    await world.verifiedPublishers.approve(byGitHub);

    await expect(world.profiles.profile(byDomain)).resolves.toMatchObject({ verifiedPublisher: true, mark: { text: "● bydomain.com", hoverLabel: "Verified Publisher" } });
    await expect(world.profiles.profile(byGitHub)).resolves.toMatchObject({ verifiedPublisher: true, mark: { text: `● github.com/fifthgh`, hoverLabel: "Verified Publisher" } });
    for (const org of [noProof, noMfa, noReview]) await expect(world.profiles.profile(org)).resolves.toMatchObject({ verifiedPublisher: false });
    await expect(noReview.verification()).resolves.toMatchObject({ application: { state: "pending" } });

    const calls = await world.recorder.invocations({ kind: "http" });
    expect(calls.filter((c) => /polar|stripe|paddle|payment|checkout/i.test(c.target))).toEqual([]);
  },
  NEEDS,
);

scenario(
  "IT-SCOPE-018 A Verified Publisher application is visible while pending and explained when denied",
  async (world) => {
    const p = await world.publishers.create({ handle: "p" });
    const q = await world.publishers.create({ handle: "q" });
    const w = await world.publishers.create({ handle: "w" });
    const acme = await p.orgs.create("acme");
    const beta = await w.orgs.create("beta");
    await acme.invite(q).as("owner");
    await world.invitations.accept(q, (await world.invitations.pending(q))[0]!);
    for (const [org, domain] of [[acme, "acme.com"], [beta, "beta.com"]] as const) {
      const challenge = await org.verifyDomain(domain);
      challenge.publishTxt();
      await org.checkDomain(challenge);
    }
    await acme.requireMfa("passkeys");

    await expect(beta.applyVerified()).toBeRefusedSaying("require MFA scope-wide");
    await expect(world.orgs.get("acme", w).applyVerified()).toBeRefused("forbidden");
    await expect(acme.applyVerified()).resolves.toMatchObject({ state: "pending" });
    await expect(acme.applyVerified()).toBeRefused("exists");

    await expect(world.verifiedPublishers.queue()).resolves.toMatchObject([{ scope: "acme", appliedBy: "p" }]);
    await expect(acme.verification()).resolves.toMatchObject({ application: { state: "pending" } });
    await expect(world.verifiedPublishers.needsYou(p)).resolves.toEqual(["acme"]);
    await expect(world.verifiedPublishers.needsYou(q)).resolves.toEqual(["acme"]);
    await expect(world.verifiedPublishers.needsYou(w)).resolves.toEqual([]);

    await world.verifiedPublishers.deny(acme, "The domain only redirects to another site");
    for (const owner of [p, q]) expect(world.mail.inbox(owner).latest().text).toContain("Reason: The domain only redirects to another site");
    await expect(world.verifiedPublishers.queue()).resolves.toEqual([]);
    await expect(world.verifiedPublishers.needsYou(p)).resolves.toEqual([]);
    const denied = await acme.verification();
    expect(denied).toMatchObject({ application: { state: "rejected", denialReason: "The domain only redirects to another site" } });
    const renewable = (denied as { application: { renewableAt: string } }).application.renewableAt.slice(0, 10);

    await world.clock.advance("29d");
    await p.signIn();
    await expect(acme.applyVerified()).toBeRefusedSaying(renewable);
    await world.clock.advance("1d");
    await p.signIn();
    await q.signIn();
    await expect(acme.applyVerified()).resolves.toMatchObject({ state: "pending" });
    await expect(world.verifiedPublishers.needsYou(q)).resolves.toEqual(["acme"]);

    await world.verifiedPublishers.approve(acme);
    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedPublisher: true });
    await expect(acme.verification()).resolves.toMatchObject({ application: { state: "approved" } });
    await expect(world.verifiedPublishers.needsYou(p)).resolves.toEqual([]);
  },
  NEEDS,
);

scenario(
  "IT-VAL-041 A scope's verification facts follow its proofs and its status; the registry applies no policy (facts source)",
  async (world) => {
    const p = await world.publishers.create({ handle: "p" });
    const q = await world.publishers.create({ handle: "q" });
    const verified = await p.orgs.create("verified");
    const plain = await q.orgs.create("plain");
    const challenge = await verified.verifyDomain("verified.example");
    challenge.publishTxt();
    await verified.checkDomain(challenge);
    await verified.requireMfa("mfa");
    await verified.applyVerified();
    await world.verifiedPublishers.approve(verified);

    await expect(world.profiles.profile(verified)).resolves.toMatchObject({ verifiedPublisher: true, verifiedDomain: "verified.example", verifiedGithubOrg: null });
    await expect(world.profiles.profile(plain)).resolves.toMatchObject({ verifiedPublisher: false, verifiedDomain: null, verifiedGithubOrg: null, held: false });

    await world.verifiedPublishers.revoke(verified, "impersonation");
    await expect(world.profiles.profile(verified)).resolves.toMatchObject({ verifiedPublisher: false, verifiedDomain: "verified.example", mark: { text: "● verified.example", hoverLabel: null } });
    await expect(world.verifiedPublishers.reindexed(verified)).resolves.toContain("verified_publisher_changed");
    expect(world.mail.inbox(p).latest().text).toContain("revoked");
  },
  NEEDS,
);

scenario(
  "IT-PAY-018 Nothing is charged: applying for Verified Publisher proceeds with no payment (verification half)",
  async (world) => {
    const p = await world.publishers.create({ handle: "p" });
    const o = await p.orgs.create("o");
    const challenge = await o.verifyDomain("o.example");
    challenge.publishTxt();
    await o.checkDomain(challenge);
    await o.requireMfa("passkeys");

    const application = await o.applyVerified();
    expect(application).toMatchObject({ state: "pending" });
    expect(Object.keys(application).sort()).toEqual(["basis", "denialReason", "renewableAt", "state"]);
    await world.verifiedPublishers.approve(o);
    await expect(o.verification()).resolves.toMatchObject({ application: { state: "approved" } });

    const calls = await world.recorder.invocations();
    expect(calls.filter((c) => /polar|stripe|paddle|payment|checkout/i.test(c.target))).toEqual([]);
  },
  NEEDS,
);

scenario(
  "JT-007 Verified Publisher application: pending, denied with a reason, renewed, approved, marked (proof half)",
  async (world) => {
    const acmeGh = world.alias("acmegh");
    const p = await world.publishers.create({ handle: "p", githubOrgs: [{ id: 7001, login: acmeGh, role: "admin" }] });
    const q = await world.publishers.create({ handle: "q" });
    const w = await world.publishers.create({ handle: "w", githubOrgs: [{ id: 7002, login: world.alias("betagh"), role: "admin" }] });
    const acme = await p.orgs.create("acme");
    const beta = await w.orgs.create("beta");
    await acme.invite(q).as("owner");
    await world.invitations.accept(q, (await world.invitations.pending(q))[0]!);
    await world.packs.public("@acme/gcp");
    await acme.verifyGitHub(acmeGh, "admin");
    await beta.verifyGitHub(world.alias("betagh"), "admin");
    await acme.requireMfa("mfa");

    await expect(beta.applyVerified()).toBeRefusedSaying("require MFA scope-wide");
    await acme.applyVerified();
    await expect(world.verifiedPublishers.needsYou(q)).resolves.toEqual(["acme"]);
    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedPublisher: false, mark: { hoverLabel: null } });

    await world.verifiedPublishers.deny(acme, "Not enough history yet");
    for (const owner of [p, q]) expect(world.mail.inbox(owner).latest().text).toContain("Reason: Not enough history yet");
    await world.clock.advance("29d");
    await p.signIn();
    await expect(acme.applyVerified()).toBeRefused("forbidden");
    await world.clock.advance("1d");
    await p.signIn();
    await acme.applyVerified();
    await world.verifiedPublishers.approve(acme);
    await expect(world.profiles.profile(acme)).resolves.toMatchObject({
      verifiedPublisher: true,
      verifiedGithubOrg: "acmegh",
      mark: { text: `● github.com/acmegh`, hoverLabel: "Verified Publisher" },
    });

    await world.verifiedPublishers.revoke(acme);
    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedPublisher: false, verifiedGithubOrg: "acmegh", mark: { text: `● github.com/acmegh`, hoverLabel: null } });
    await expect(world.verifiedPublishers.reindexed(acme)).resolves.toContain("verified_publisher_changed");
  },
  NEEDS,
);
