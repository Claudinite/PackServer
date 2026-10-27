import { expect, scenario } from "@packserver/test-world";
import type { PackPageView, ScenarioOpts } from "@packserver/test-world";

const NEEDS: ScenarioOpts = { needs: ["fakes", "storage", "clock", "reset"] };

const linkTo = (world: { link(path: string): string }, host: string, path: string): string => world.link(path).replace("example.org", host);

scenario(
  "IT-SCORE-003 Rules are versioned and a change rescores every newest eligible version",
  async (world) => {
    await world.publishers.create({ handle: "sc" });
    const archive = async (n: string) => (await world.validation.offlineCanonical(world.archive("gcp", { files: { "README.md": `# ${n}\n` } }))).bytes;
    const packs: Awaited<ReturnType<typeof world.packs.public>>[] = [];
    for (const n of ["one", "two", "three"]) packs.push(await world.packs.public(`@sc/${n}`, { canonicalArchive: await archive(n) }));
    for (const pack of packs) await world.search.list(pack, { pitch: "A pack so a page is on show" });
    const shown = async (pack: (typeof packs)[number]) => {
      const view = (await pack.page()) as PackPageView;
      return { rules: view.trust.split("rules ")[1]?.split(" ")[0], link: view.links.some((l) => l.href === "/rules" && l.text === view.trust.split("rules ")[1]?.split(" ")[0]), score: (await pack.version("1.0.0").detail()).score.total };
    };
    const before = await Promise.all(packs.map(shown));
    expect(before.every((b) => b.rules && b.link)).toBe(true);
    expect(new Set(before.map((b) => b.rules)).size).toBe(1);

    await world.cron.run("rescan");

    const after = await Promise.all(packs.map(shown));
    expect(after.every((a) => a.rules && a.link)).toBe(true);
    expect(new Set(after.map((a) => a.rules)).size).toBe(1);
    expect(after[0]?.rules).not.toBe(before[0]?.rules);
    for (const [n, pack] of packs.entries()) expect(after[n]?.score, pack.name).not.toBe(before[n]?.score);
  },
  NEEDS,
);

scenario(
  "JT-005 (rescan leg) Live versions are rescanned on a rules change, weekly for domains and weekly through the full pipeline; a finding quarantines and only a human revokes",
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
    const leaky = await world.packs.public("@acme/leaky", { canonicalArchive: (await world.validation.offlineCanonical(world.archive("with-secret"))).bytes });
    const rulesOf = async (pack: typeof plain) => (await pack.version("1.0.0").detail()).rules_version;
    const live = [installing, linking, plain];
    const seeded = await Promise.all(live.map(rulesOf));

    world.dns.resolveHost("install.example.net");
    world.dns.resolveHost("docs.example.net");

    await world.cron.run("rescan");
    await world.cron.run("domain-drift");
    const rescanned = await Promise.all(live.map(rulesOf));
    for (const [n, rules] of rescanned.entries()) expect(rules, live[n]?.name).not.toBe(seeded[n]);
    await expect(leaky.version("1.0.0").status()).resolves.toBe("quarantined");
    for (const pack of [installing, linking, plain]) await expect(pack.version("1.0.0").status()).resolves.toBe("active");

    world.dns.unresolveHost("install.example.net");
    world.dns.unresolveHost("docs.example.net");
    await world.clock.advance("8d");
    await world.cron.run("domain-drift");

    await expect(installing.version("1.0.0").status()).resolves.toBe("quarantined");
    await expect(installing.read({ version: "1.0.0" })).toBeHeld();
    await expect(linking.version("1.0.0").status()).resolves.toBe("active");
    await expect(plain.version("1.0.0").status()).resolves.toBe("active");

    await world.search.list(linking, { pitch: "A pack so a page is on show" });
    const warned = (await linking.page()) as PackPageView;
    expect(warned.trust + warned.text).toContain("docs.example.net");
    const mails = world.mail.inbox(owner).all().filter((m) => m.subject.includes("now resolves differently"));
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toContain("/linking");

    const admin = await world.admins.create();
    expect(await world.admins.internal("admin_app", { method: "unquarantine_version", pack: installing.version("1.0.0").pack.systemName, version: "1.0.0", reason: "cleared" }, { assertion: "valid" })).toMatchObject({ ok: true });
    await expect(installing.version("1.0.0").status()).resolves.toBe("active");
    await admin.revoke(plain.version("1.0.0"), { reason: "malicious install step", security: "Exfiltrates credentials." });
    await expect(plain.version("1.0.0").status()).resolves.toBe("revoked");
    for (const pack of [installing, linking]) await expect(pack.version("1.0.0").status()).resolves.not.toBe("revoked");

    const canonicalOf = async (fixture: Parameters<typeof world.archive>[0]) => (await world.validation.offlineCanonical(world.archive(fixture))).bytes;
    const leaking = await world.packs.public("@acme/leaking", { canonicalArchive: await canonicalOf("with-secret") });
    world.github.publicRepo("org/app", { declares: [leaking] });
    expect((await world.github.scan.run()).outcome).toBe("completed");

    await world.cron.run("top-pack-rescan");

    await expect(leaking.version("1.0.0").status()).resolves.toBe("quarantined");
  },
  NEEDS,
);
