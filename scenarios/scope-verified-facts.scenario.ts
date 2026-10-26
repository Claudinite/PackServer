import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

// Each scenario starts from an empty world: a verified name makes confusable names unavailable to every later scenario.
const NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "reset"] };

scenario(
  "IT-VAL-041 A scope's verification facts follow its proofs and its status; the registry applies no policy (facts source)",
  async (world) => {
    const p = await world.publishers.create({ handle: "p", mfa: "passkey" });
    const q = await world.publishers.create({ handle: "q" });
    const verified = await p.orgs.create("verified");
    const plain = await q.orgs.create("plain");
    // A Verified Publisher's own versions are staged (REQ-PUB-019), so these are published before the approval.
    const verifiedVersion = await p.publish(world.archive("gcp", { version: "1.0.0" })).as("@verified/gcp@1.0.0");
    const plainVersion = await q.publish(world.archive("gcp", { version: "1.0.0" })).as("@plain/gcp@1.0.0");
    for (const admitted of [verifiedVersion, plainVersion]) {
      await world.validation.completes(admitted);
      await admitted.promoted();
    }

    const challenge = await verified.verifyDomain("verified.example");
    challenge.publishTxt();
    await verified.checkDomain(challenge);
    await verified.requireMfa("mfa");
    await verified.applyVerified();
    await world.verifiedPublishers.approve(verified);

    await expect(world.profiles.profile(verified)).resolves.toMatchObject({ verifiedPublisher: true, verifiedDomain: "verified.example", verifiedGithubOrg: null });
    await expect(world.profiles.profile(plain)).resolves.toMatchObject({ verifiedPublisher: false, verifiedDomain: null, verifiedGithubOrg: null, held: false });

    // The signed index follows the status once the approval is made.
    const approved = (await world.registry.proofChanged(verifiedVersion.pack)).scope.document.packs[0]?.versions[0];
    expect(approved).toMatchObject({ verified: true, verified_github_org: null });
    expect(world.unalias(String(approved?.verified_domain))).toBe("verified.example");
    expect((await world.registry.indexes(plainVersion.pack)).scope.document.packs[0]?.versions[0]).toMatchObject({
      verified: false,
      verified_domain: null,
      verified_github_org: null,
    });
    expect(await plainVersion.verification()).toEqual({ verified: false });

    // A Verified Publisher's next version waits for the owner's approval instead of being promoted.
    const staged = await p.publish(world.archive("gcp", { version: "1.1.0" })).as("@verified/gcp@1.1.0");
    await world.validation.completes(staged);
    const control = await q.publish(world.archive("gcp", { version: "1.1.0" })).as("@plain/gcp@1.1.0");
    await world.validation.completes(control);
    await control.promoted();
    await expect(staged.status()).rejects.toThrow(/has no version row/);

    await world.verifiedPublishers.revoke(verified, "impersonation");
    await expect(world.profiles.profile(verified)).resolves.toMatchObject({ verifiedPublisher: false, verifiedDomain: "verified.example", mark: { text: "● verified.example", hoverLabel: null } });
    await expect(world.verifiedPublishers.reindexed(verified)).resolves.toContain("verified_publisher_changed");
    expect(world.mail.inbox(p).latest().text).toContain("revoked");
    const revoked = (await world.registry.proofChanged(verifiedVersion.pack)).scope.document.packs[0]?.versions[0];
    expect(revoked).toMatchObject({ verified: false, verified_github_org: null });
    expect(world.unalias(String(revoked?.verified_domain))).toBe("verified.example");
  },
  NEEDS,
);

scenario(
  "JT-007 Verified Publisher application: pending, denied with a reason, renewed, approved, marked (proof half)",
  async (world) => {
    const acmeGh = world.alias("acmegh");
    const p = await world.publishers.create({ handle: "p", mfa: "passkey", githubOrgs: [{ id: 7001, login: acmeGh, role: "admin" }] });
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
