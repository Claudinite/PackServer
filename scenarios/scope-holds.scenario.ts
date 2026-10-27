import { expect, scenario } from "@packserver/test-world";
import type { ScenarioOpts } from "@packserver/test-world";

// Each scenario starts from an empty world: a verified name makes confusable names unavailable to every later scenario.
const NEEDS: ScenarioOpts = { needs: ["fakes", "clock", "storage", "reset"] };

scenario(
  "IT-SCOPE-011 First proof holds a colliding name and never reassigns a publishing scope",
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

    const admin = await world.admins.create();
    await admin.disputes.resolve(squatter, { kind: "reassign" });
    await expect(world.orgs.get("acme", r).profile()).resolves.toMatchObject({ name: "acme", verifiedDomain: "acme.com" });
    expect(world.mail.inbox(s).all().some((m) => m.subject.includes("is now"))).toBe(true);

    await expect(admin.disputes.resolve(publishing, { kind: "reassign" })).rejects.toThrow();
    await admin.disputes.resolve(publishing, { kind: "notice" });
    await expect(world.profiles.profile(publishing)).resolves.toMatchObject({ name: "acmeinc", disputed: { domain: "acmeinc.com" } });
    await publishing.consentReassign();
    await admin.disputes.resolve(publishing, { kind: "reassign" });
    await expect(world.orgs.get("acmeinc", v).profile()).resolves.toMatchObject({ name: "acmeinc" });
    expect(world.mail.inbox(t).all().some((m) => m.subject.includes("is now"))).toBe(true);
    expect((await admin.audit()).filter((a) => a.verb?.startsWith("dispute.")).length).toBeGreaterThanOrEqual(3);
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

