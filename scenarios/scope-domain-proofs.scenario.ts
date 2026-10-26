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

