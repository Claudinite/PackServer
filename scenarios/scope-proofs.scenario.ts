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

