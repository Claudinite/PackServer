import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

// Each scenario starts from an empty world: a verified name makes confusable names unavailable to every later scenario.
const NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "reset"] };

scenario(
  "IT-SCOPE-010 Verified Publisher needs a proof, scope-wide MFA and a review; no subscription",
  async (world) => {
    const githubOrg = world.alias("fifthgh");
    const p1 = await world.publishers.create({ handle: "p1", mfa: "passkey" });
    const p2 = await world.publishers.create({ handle: "p2" });
    const p3 = await world.publishers.create({ handle: "p3", mfa: "passkey" });
    const p4 = await world.publishers.create({ handle: "p4", mfa: "passkey" });
    const p5 = await world.publishers.create({ handle: "p5", mfa: "passkey", githubOrgs: [{ id: 7005, login: githubOrg, role: "admin" }] });
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

    world.dns.remove("noreview.com");
    world.dns.remove("bydomain.com");
    await world.clock.advance("30d");
    await world.cron.run("domain-rechecks");
    await world.clock.advance("30d");
    await world.cron.run("domain-rechecks");
    await p3.signIn();
    await expect(world.verifiedPublishers.approve(noReview)).toBeRefusedSaying("no longer meets the conditions");
    await expect(noReview.verification()).resolves.toMatchObject({ application: { state: "pending" } });
    await expect(world.profiles.profile(byDomain)).resolves.toMatchObject({ verifiedPublisher: false, verifiedPublisherLapsed: true, verifiedDomain: null });

    await p4.signIn();
    const again = await byDomain.verifyDomain("bydomain.com");
    again.publishTxt();
    await byDomain.checkDomain(again);
    await expect(world.profiles.profile(byDomain)).resolves.toMatchObject({ verifiedPublisher: true, verifiedPublisherLapsed: false });

    const calls = await world.recorder.invocations({ kind: "http" });
    expect(calls.filter((c) => /polar|stripe|paddle|payment|checkout/i.test(c.target))).toEqual([]);
  },
  NEEDS,
);

scenario(
  "IT-SCOPE-018 A Verified Publisher application is visible while pending and explained when denied",
  async (world) => {
    const p = await world.publishers.create({ handle: "p", mfa: "passkey" });
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
    await acme.requireMfa("passkey");

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

