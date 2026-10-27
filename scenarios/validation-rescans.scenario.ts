import { expect, scenario } from "@packserver/test-world";
import type { PackPageView, ScenarioOpts } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "clock", "reset"] };

const linkTo = (world: { link(path: string): string }, host: string, path: string): string => world.link(path).replace("example.org", host);

scenario(
  "IT-VAL-018 Live versions are rescanned and a finding quarantines; only a human revokes",
  async (world) => {
    const owner = await world.publishers.create({ handle: "own" });
    await owner.orgs.create("acme");
    const installer = linkTo(world, "install.example.net", "setup.tar.gz");
    const prose = linkTo(world, "docs.example.net", "guide");
    const bytes = async (readme: string) => (await world.validation.offlineCanonical(world.archive("gcp", { files: { "README.md": readme } }))).bytes;
    const installing = await world.packs.public("@acme/installer", {
      canonicalArchive: await bytes(`# installer\n\nFirst pip install ${installer} and then continue.\n`),
      urls: [{ url: installer, domain: "install.example.net", classification: "install", file: "README.md", line: 3 }],
    });
    const linking = await world.packs.public("@acme/linking", {
      canonicalArchive: await bytes(`# linking\n\nSee ${prose} for background.\n`),
      urls: [{ url: prose, domain: "docs.example.net", classification: "docs", file: "README.md", line: 3 }],
    });
    const plain = await world.packs.public("@acme/plain", { canonicalArchive: await bytes("# plain\n\nNothing to see.\n") });
    const revoked = await world.packs.public("@acme/revoked", { canonicalArchive: await bytes("# revoked\n\nNothing to see.\n") });

    world.dns.resolveHost("install.example.net");
    world.dns.resolveHost("docs.example.net");

    await world.cron.run("rescan");
    await world.cron.run("domain-drift");
    for (const pack of [installing, linking, plain]) await expect(pack.version("1.0.0").status()).resolves.toBe("active");

    world.dns.unresolveHost("install.example.net");
    world.dns.unresolveHost("docs.example.net");
    await world.clock.advance("8d");
    await world.cron.run("domain-drift");
    await world.cron.run("top-pack-rescan");

    await expect(installing.version("1.0.0").status()).resolves.toBe("quarantined");
    await expect(linking.version("1.0.0").status()).resolves.toBe("active");
    await expect(plain.version("1.0.0").status()).resolves.toBe("active");

    await world.search.list(linking, { pitch: "A pack so a page is on show" });
    const warned = (await linking.page()) as PackPageView;
    expect(warned.trust + warned.text).toContain("docs.example.net");
    const mails = world.mail.inbox(owner).all().filter((m) => m.subject.includes("now resolves differently"));
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toContain("/linking");

    await installing.version("1.0.0").seed({ status: "active" });
    await expect(installing.version("1.0.0").status()).resolves.toBe("active");

    await revoked.version("1.0.0").seed({ status: "revoked", reason: "malware", security: "malware" });
    await expect(revoked.version("1.0.0").status()).resolves.toBe("revoked");
    for (const pack of [installing, linking, plain]) await expect(pack.version("1.0.0").status()).resolves.not.toBe("revoked");
  },
  NEEDS,
);

scenario(
  "IT-SCORE-003 Rules are versioned and a change rescores every newest eligible version",
  async (world) => {
    await world.publishers.create({ handle: "sc" });
    const archive = async (n: string) => (await world.validation.offlineCanonical(world.archive("gcp", { files: { "README.md": `# ${n}\n` } }))).bytes;
    const packs: Awaited<ReturnType<typeof world.packs.public>>[] = [];
    for (const n of ["one", "two", "three"]) packs.push(await world.packs.public(`@sc/${n}`, { canonicalArchive: await archive(n) }));
    for (const pack of packs) await world.search.list(pack, { pitch: "A pack so a page is on show" });
    const rulesShown = async (pack: (typeof packs)[number]) => ((await pack.page()) as PackPageView).trust.split("rules ")[1]?.split(" ")[0];
    const before = await Promise.all(packs.map(rulesShown));
    expect(before.every(Boolean)).toBe(true);
    expect(new Set(before).size).toBe(1);

    await world.cron.run("rescan");

    const after = await Promise.all(packs.map(rulesShown));
    expect(new Set(after).size).toBe(1);
    expect(after.every(Boolean)).toBe(true);
    expect(after[0]).not.toBe(before[0]);
  },
  NEEDS,
);

scenario(
  "JT-005 (rescan leg) The weekly pipeline pass quarantines a declared pack that no longer passes and spares the clean ones",
  async (world) => {
    await world.publishers.create({ handle: "pip" });
    const canonical = async (fixture: Parameters<typeof world.archive>[0]) => (await world.validation.offlineCanonical(world.archive(fixture))).bytes;
    const clean = await world.packs.public("@pip/clean", { canonicalArchive: await canonical("gcp") });
    const leaking = await world.packs.public("@pip/leaking", { canonicalArchive: await canonical("with-secret") });
    const undeclared = await world.packs.public("@pip/undeclared", { canonicalArchive: await canonical("with-secret") });
    world.github.publicRepo("org/app", { declares: [clean, leaking] });
    expect((await world.github.scan.run()).outcome).toBe("completed");

    await world.cron.run("top-pack-rescan");

    await expect(clean.version("1.0.0").status()).resolves.toBe("active");
    await expect(leaking.version("1.0.0").status()).resolves.toBe("quarantined");
    await expect(undeclared.version("1.0.0").status()).resolves.toBe("active");
  },
  NEEDS,
);
