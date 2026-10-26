import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

// Each scenario starts from an empty world: a verified name makes confusable names unavailable to every later scenario.
const NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "reset"] };

scenario(
  "IT-SCOPE-004 Domain proof by DNS TXT or .well-known",
  async (world) => {
    const p = await world.publishers.create({ handle: "p" });
    const q = await world.publishers.create({ handle: "q" });
    const r = await world.publishers.create({ handle: "r" });
    const acme = await p.orgs.create("acme");
    const beta = await q.orgs.create("beta");
    const gamma = await r.orgs.create("gamma");

    const byRecord = await acme.verifyDomain("acme.com");
    await expect(acme.checkDomain(byRecord)).resolves.toMatchObject({ status: "missing" });
    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedDomain: null });
    byRecord.publishTxt();
    await expect(acme.checkDomain(byRecord)).resolves.toMatchObject({ status: "verified", method: "txt", transferred: false });

    const byFile = await beta.verifyDomain("beta.example");
    byFile.serveFile();
    await expect(beta.checkDomain(byFile)).resolves.toMatchObject({ status: "verified", method: "well-known" });

    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedDomain: "acme.com", mark: { text: "● acme.com" } });
    await expect(world.profiles.profile(beta)).resolves.toMatchObject({ verifiedDomain: "beta.example" });
    await expect(acme.verification()).resolves.toMatchObject({ domain: { proven: { domain: "acme.com", method: "txt" }, pending: [] } });

    world.dns.publishTxt("gamma.com", "a-token-that-is-not-gammas");
    const wrong = await gamma.verifyDomain("gamma.com");
    await expect(gamma.checkDomain(wrong)).resolves.toMatchObject({ status: "mismatch" });
    await expect(world.profiles.profile(gamma)).resolves.toMatchObject({ verifiedDomain: null, mark: { kind: "unproven" } });

    await expect(world.orgs.get("acme", p).verifyDomain("acme.org", { assertion: "none" })).toBeRefused("step-up");
    await expect(world.orgs.get("acme", q).verifyDomain("acme.org")).toBeRefused("forbidden");
    expect(await world.github.writes()).toEqual([]);
  },
  NEEDS,
);

scenario(
  "IT-SCOPE-005 Public-suffix domains are rejected; subdomains show the full host",
  async (world) => {
    const p = await world.publishers.create({ handle: "p" });
    const acme = await p.orgs.create("acme");

    await expect(acme.verifyDomain("github.io")).toBeRefusedSaying("public suffix");
    await expect(acme.verifyDomain("co.uk")).toBeRefusedSaying("public suffix");
    await expect(acme.verifyDomain("not a domain")).toBeRefusedSaying("domain name");
    expect(world.dns.lookups()).toEqual([]);
    expect(world.dns.hostRequests()).toEqual([]);

    const sub = await acme.verifyDomain("docs.acme.com");
    sub.publishTxt();
    await expect(acme.checkDomain(sub)).resolves.toMatchObject({ status: "verified" });
    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedDomain: "docs.acme.com", mark: { text: "● docs.acme.com" } });
  },
  NEEDS,
);

scenario(
  "IT-SCOPE-006 Domain proof is re-checked and lapses with a warning",
  async (world) => {
    const p = await world.publishers.create({ handle: "p" });
    const q = await world.publishers.create({ handle: "q" });
    const acme = await p.orgs.create("acme");
    const beta = await q.orgs.create("beta");
    for (const [org, domain] of [[acme, "acme.com"], [beta, "beta.com"]] as const) {
      const challenge = await org.verifyDomain(domain);
      challenge.publishTxt();
      await org.checkDomain(challenge);
    }
    world.dns.remove("beta.com");

    await world.clock.advance("29d");
    await world.cron.run("domain-rechecks");
    expect(world.mail.inbox(q).all().filter((m) => m.subject.startsWith("Domain proof"))).toHaveLength(0);

    await world.clock.advance("1d");
    await world.cron.run("domain-rechecks");
    await expect(world.profiles.profile(beta)).resolves.toMatchObject({ verifiedDomain: "beta.com" });
    expect(world.mail.inbox(q).all().filter((m) => m.subject.startsWith("Domain proof")).map((m) => m.subject)).toEqual([expect.stringContaining("is failing")]);

    await world.clock.advance("15d");
    await world.cron.run("domain-rechecks");
    await expect(world.profiles.profile(beta)).resolves.toMatchObject({ verifiedDomain: "beta.com" });

    await world.clock.advance("15d");
    await world.cron.run("domain-rechecks");
    await expect(world.profiles.profile(beta)).resolves.toMatchObject({ verifiedDomain: null, mark: { kind: "unproven" } });
    await expect(world.verifiedPublishers.reindexed(beta)).resolves.toContain("domain_lapsed");
    expect(world.mail.inbox(q).all().filter((m) => m.subject.startsWith("Domain proof"))).toHaveLength(1);

    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedDomain: "acme.com" });
    await expect(world.verifiedPublishers.reindexed(acme)).resolves.not.toContain("domain_lapsed");
    expect(world.mail.inbox(p).all().filter((m) => m.subject.startsWith("Domain proof"))).toHaveLength(0);
  },
  NEEDS,
);

scenario(
  "IT-SCOPE-007 A re-check moves only the proof, never the scope; a domain regained within a year carries a transfer mark",
  async (world) => {
    const a = await world.publishers.create({ handle: "a" });
    const m = await world.publishers.create({ handle: "m" });
    const b = await world.publishers.create({ handle: "b" });
    const acme = await a.orgs.create("acme");
    const beta = await b.orgs.create("beta");
    await acme.invite(m).as("maintainer");
    await world.invitations.accept(m, (await world.invitations.pending(m))[0]!);
    await world.packs.public("@acme/one");
    await world.packs.public("@acme/two");

    const held = await acme.verifyDomain("acme.com");
    held.publishTxt();
    await acme.checkDomain(held);
    await world.clock.advance("10d");
    await a.signIn();
    await b.signIn();

    const claim = await beta.verifyDomain("acme.com");
    world.dns.remove("acme.com");
    claim.publishTxt();
    await expect(beta.checkDomain(claim)).resolves.toMatchObject({ status: "verified", transferred: true, movedFrom: "acme" });

    await expect(world.profiles.profile(acme)).resolves.toMatchObject({
      verifiedDomain: null,
      verifiedDomainTransferredAt: null,
      held: false,
      disputed: null,
      packs: ["@acme/one", "@acme/two"],
    });
    const moved = await world.profiles.profile(beta);
    expect(moved).toMatchObject({ verifiedDomain: "acme.com", mark: { text: "● acme.com" } });
    expect((moved as { verifiedDomainTransferredAt: string | null }).verifiedDomainTransferredAt).not.toBeNull();
    await expect(acme.people()).resolves.toMatchObject({ people: [{ handle: "a", role: "owner" }, { handle: "m", role: "maintainer" }] });

    expect(world.mail.inbox(a).all().filter((n) => n.subject.includes("no longer verified"))).toHaveLength(1);
    expect(world.mail.inbox(b).all().filter((n) => n.subject.includes("no longer verified"))).toHaveLength(0);

    await expect(beta.verifyDomain("other.com")).toBeRefusedSaying("already holds");

    {
      const a2 = await world.publishers.create({ handle: "a2" });
      const b2 = await world.publishers.create({ handle: "b2" });
      const older = await a2.orgs.create("older");
      const newer = await b2.orgs.create("newer");

      const first = await older.verifyDomain("older.example");
      first.publishTxt();
      await expect(older.checkDomain(first)).resolves.toMatchObject({ transferred: false });
      await expect(world.profiles.profile(older)).resolves.toMatchObject({ verifiedDomainTransferredAt: null });

      world.dns.remove("older.example");
      await world.clock.advance("30d");
      await world.cron.run("domain-rechecks");
      await world.clock.advance("30d");
      await world.cron.run("domain-rechecks");
      await expect(world.profiles.profile(older)).resolves.toMatchObject({ verifiedDomain: null });

      await world.clock.advance("200d");
      await b2.signIn();
      const later = await newer.verifyDomain("older.example");
      later.publishTxt();
      await expect(newer.checkDomain(later)).resolves.toMatchObject({ status: "verified", transferred: true, movedFrom: null });
    }
  },
  NEEDS,
);

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
  "IT-SCOPE-011 First proof holds a colliding name and never reassigns a publishing scope (proof half)",
  async (world) => {
    const s = await world.publishers.create({ handle: "s" });
    const t = await world.publishers.create({ handle: "t" });
    const r = await world.publishers.create({ handle: "r" });
    const v = await world.publishers.create({ handle: "v" });
    const squatter = await s.orgs.create("acme");
    const publishing = await t.orgs.create("acmeinc");
    const real = await r.orgs.create("rightful");
    const other = await v.orgs.create("another");
    await world.packs.public("@acmeinc/gcp");

    const first = await real.verifyDomain("acme.com");
    first.publishTxt();
    await real.checkDomain(first);
    await expect(world.profiles.profile(squatter)).resolves.toMatchObject({ held: true, disputed: { domain: "acme.com" }, name: "acme" });
    expect(world.mail.inbox(s).all().filter((m) => m.subject.includes("is disputed"))).toHaveLength(1);
    await expect(world.profiles.profile(real)).resolves.toMatchObject({ verifiedDomain: "acme.com", held: false, disputed: null });

    const second = await other.verifyDomain("acmeinc.com");
    second.publishTxt();
    await other.checkDomain(second);
    await expect(world.profiles.profile(publishing)).resolves.toMatchObject({ held: false, disputed: { domain: "acmeinc.com" }, packs: ["@acmeinc/gcp"] });
    expect(world.mail.inbox(t).all().find((m) => m.subject.includes("is disputed"))!.text).toContain("keeps its name");

    const name = await world.profiles.profile(publishing);
    expect(name).toMatchObject({ name: "acmeinc", kind: "org" });
    await expect(publishing.people()).resolves.toMatchObject({ people: [{ handle: "t", role: "owner" }] });
  },
  NEEDS,
);

scenario(
  "IT-SCOPE-017 The domain-proof fetch is narrow and nothing else is fetched (check half)",
  async (world) => {
    const p = await world.publishers.create({ handle: "p" });
    const acme = await p.orgs.create("acme");
    const challenge = await acme.verifyDomain("acme.com");

    world.dns.redirectFile("acme.com");
    await expect(acme.checkDomain(challenge)).resolves.toMatchObject({ status: "missing", detail: "redirected" });
    expect(world.dns.hostRequests()).toEqual([{ host: "acme.com", asked: "proof file" }]);

    world.dns.oversizeFile("acme.com", 5 * 1024 * 1024);
    await expect(acme.checkDomain(challenge)).resolves.toMatchObject({ status: "missing", detail: "too_large" });

    world.dns.hostDown("acme.com");
    await expect(acme.checkDomain(challenge)).resolves.toMatchObject({ status: "missing" });
    await expect(world.profiles.profile(acme)).resolves.toMatchObject({ verifiedDomain: null });
    expect(world.dns.hostRequests().every((r) => r.host === "acme.com" && r.asked === "proof file")).toBe(true);

    world.dns.failResolver(true);
    await expect(acme.checkDomain(challenge)).resolves.toMatchObject({ status: "unreachable" });
    world.dns.failResolver(false);
    challenge.publishTxt();
    await expect(acme.checkDomain(challenge)).resolves.toMatchObject({ status: "verified" });
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
