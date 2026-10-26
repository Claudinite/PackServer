import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

// Each scenario starts from an empty world: a verified name makes confusable names unavailable to every later scenario.
const NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "reset"] };

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
