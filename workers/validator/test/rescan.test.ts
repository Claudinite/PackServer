import { weekOf } from "@packserver/core/validation";
import { canonicalise, extractArchive } from "@packserver/core/canonical";
import { fixtureArchive, type ArchiveOpts } from "@packserver/core/canonical/fixtures";
import { objectKey } from "@packserver/core/catalog";
import { DNS_NAME_UNANSWERED, PortError } from "@packserver/ports";
import type { Meta } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { rescanRoute } from "../src/rescan/route";
import { DOMAIN_BUDGET } from "../src/rescan/domains";
import { collect, domainsPass, pipelinePass, rulesPass, tick } from "../src/rescan/tick";
import { RESCAN_PRINCIPAL } from "../src/workflow/upload";
import { seedScope, testRuntime } from "./support";

type Runtime = Awaited<ReturnType<typeof testRuntime>>;

const SECRET = fixtureArchive("with-secret", { version: "1.0.0" });
const GOOD = (files: ArchiveOpts["files"] = {}) => fixtureArchive("gcp", { version: "1.0.0", files });
const INSTALL_README = { "README.md": "# gcp\n\nInstall from https://install.example.com/toolkit first.\n" };
const PROSE_README = { "README.md": "# gcp\n\nSee https://docs.example.org/guide for the full story.\n" };

interface Published {
  scope: string;
  pack: string;
  version?: string;
  archive: Uint8Array;
  rules?: string;
  urls?: Meta["url_inventory"];
  state?: string;
}

/** A version as promotion leaves it: the canonical archive and `meta.json` in the public bucket, the row in D1. */
async function publish(t: Runtime, p: Published): Promise<{ id: string; name: string }> {
  const version = p.version ?? "1.0.0";
  const name = `@${p.scope}/${p.pack}`;
  const canonical = canonicalise(await extractArchive(p.archive));
  seedScope(t.db, { scope: p.scope, pack: p.pack, versions: [{ version, state: p.state ?? "active" }] });
  const id = `v-${p.scope}-${p.pack}-${version}`;
  const rules = p.rules ?? "2026.10.1";
  t.db.prepare(`update pack_versions set sha256 = ?, score = 80, score_rules_version = ?, size_bytes = ? where id = ?`).run(canonical.sha256, rules, canonical.archive.length, id);
  const meta: Meta = {
    pack: name as Meta["pack"],
    version,
    inventory: Object.fromEntries(["skills", "rules", "checks", "guards", "tasks", "env-setup", "forced-skills", "github-actions"].map((k) => [k, { count: 0, names: [], tokens: null }])) as unknown as Meta["inventory"],
    capabilities: [],
    preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] },
    url_inventory: p.urls ?? [],
    score: { total: 80, parts: [], cap: null },
    rules_version: rules,
    verification: { verified: false, verified_domain: null, verified_github_org: null, source_verified: false },
    provenance: { source: "upload", source_verified: false },
    diff_summary: { previous_version: null, files_added: 0, files_removed: 0, files_changed: 0, new_capabilities: [] },
  };
  await t.publicBucket.put(objectKey(name, "archive", version), canonical.archive);
  await t.publicBucket.put(objectKey(name, "meta", version), new TextEncoder().encode(JSON.stringify(meta)));
  return { id, name };
}

const state = (t: Runtime, id: string) => t.db.prepare(`select state, status_reason, score, score_rules_version, score_breakdown from pack_versions where id = ?`).get(id) as Record<string, unknown>;
const link = (url: string, classification: string): Meta["url_inventory"][number] => ({ url, domain: new URL(url).hostname, classification, file: "README.md", line: 3 });
const reindexed = (t: Runtime) => t.fakes.queues["REINDEX_QUEUE"]!.messages;

function owner(t: Runtime, scope: string, address = "owner@example.test") {
  t.db.exec(`insert or ignore into users (id, handle, created_at) values ('u-${scope}', 'u${scope}', 'x');
    insert into user_emails (user_id, address, source, created_at) values ('u-${scope}', '${address}', 'github', 'x');
    insert into scope_members (scope_id, user_id, role, created_at) values ('s-${scope}', 'u-${scope}', 'owner', 'x');`);
}

describe("the rules pass", () => {
  it("rescans and rescores a version validated under older rules, and leaves it active when nothing new turns up", async () => {
    const t = await testRuntime();
    const v = await publish(t, { scope: "acme", pack: "gcp", archive: GOOD() });
    const progress = await rulesPass(t.rt);
    expect(progress).toMatchObject({ kind: "rules", trigger: "2026.10.2", visited: 1, findings: 0, completed: true });
    expect(state(t, v.id)).toMatchObject({ state: "active", status_reason: null, score: 69, score_rules_version: "2026.10.2" });
    expect(JSON.parse(String(state(t, v.id).score_breakdown))).toMatchObject({ parts: expect.any(Array), cap: null });
    expect(reindexed(t)).toEqual([]);
    expect(t.fakes.stats.points.find((p) => p.name === "rescan.completed")).toMatchObject({ blobs: ["rules", "2026.10.2"], doubles: [1, 0] });
  });

  it("does nothing a second time, and nothing for a version validated under the rules already in force", async () => {
    const t = await testRuntime();
    await publish(t, { scope: "acme", pack: "gcp", archive: GOOD() });
    await publish(t, { scope: "acme", pack: "fresh", archive: GOOD(), rules: "2026.10.2" });
    await rulesPass(t.rt);
    const again = await rulesPass(t.rt);
    expect(again).toMatchObject({ visited: 0, completed: true });
    expect(t.fakes.stats.points.filter((p) => p.name === "rescan.completed")).toHaveLength(1);
    expect(state(t, "v-acme-fresh-1.0.0")).toMatchObject({ score: 80 });
  });

  it("quarantines with the rule as the reason on a new fail, asks the reindex queue to rebuild, and never revokes", async () => {
    const t = await testRuntime();
    const v = await publish(t, { scope: "acme", pack: "leaky", archive: SECRET });
    const progress = await rulesPass(t.rt);
    expect(progress.findings).toBeGreaterThan(0);
    const row = state(t, v.id);
    expect(row.state).toBe("quarantined");
    expect(String(row.status_reason)).toMatch(/^[a-z]+[.-]/);
    expect(row.score_rules_version).toBe("2026.10.2");
    expect(reindexed(t)).toEqual([{ schema: 1, type: "scope.proof_changed", scope: "acme", change: "version_status_changed" }]);
    expect(t.fakes.stats.points.find((p) => p.name === "moderation.quarantined")).toBeDefined();
  });

  it("leaves a version whose hold a person approved, and quarantines one whose stored report does not carry it", async () => {
    const t = await testRuntime();
    const approved = await publish(t, { scope: "acme", pack: "installer", archive: GOOD(INSTALL_README) });
    await rulesPass(t.rt);
    expect(state(t, approved.id).state).toBe("active");

    const t2 = await testRuntime();
    const unreported = await publish(t2, { scope: "acme", pack: "installer", archive: GOOD(INSTALL_README) });
    t2.db.prepare(`update pack_versions set report_key = 'runs/r1/report.json' where id = ?`).run(unreported.id);
    const report = { run_id: "r1", pack: "@acme/installer", version: "1.0.0", rules_version: "2026.10.1", started_at: "2026-10-22T12:00:00.000Z", finished_at: "2026-10-22T12:01:00.000Z", verdict: "warn", steps: [], findings: [{ rule: "license.missing", class: "warn", file: null, line: null, quote: null, hint: "x" }], tree_hash: null, canonical_sha256: null, source_verified: false, prose_screen: null, score: 70 };
    await t2.fakes.r2["VALIDATION_REPORTS"]!.put("runs/r1/report.json", new TextEncoder().encode(JSON.stringify(report)));
    await rulesPass(t2.rt);
    expect(state(t2, unreported.id)).toMatchObject({ state: "quarantined", status_reason: "text.url-install" });
  });

  it("does not quarantine a version that is not active, and skips one whose archive no longer matches its committed hash", async () => {
    const t = await testRuntime();
    const yanked = await publish(t, { scope: "acme", pack: "old", archive: SECRET, state: "yanked" });
    const altered = await publish(t, { scope: "acme", pack: "altered", archive: SECRET });
    t.db.prepare(`update pack_versions set sha256 = ? where id = ?`).run("b".repeat(64), altered.id);
    await rulesPass(t.rt);
    expect(state(t, yanked.id)).toMatchObject({ state: "yanked", score_rules_version: "2026.10.1" });
    expect(state(t, altered.id)).toMatchObject({ state: "active", score_rules_version: "2026.10.1" });
  });

  it("visits only the newest eligible version of each pack, a batch of packs at a time, and resumes where it stopped", async () => {
    const t = await testRuntime();
    (t.rt.config as { rescanBatch: () => number }).rescanBatch = () => 1;
    await publish(t, { scope: "acme", pack: "a", archive: GOOD(), version: "1.0.0" });
    t.db.prepare(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified, score_rules_version) values ('v-a-2', 'p-acme-a', '2.0.0', 'active', ?, 1, 'x', 0, 0, '2026.10.1')`).run("c".repeat(64));
    await publish(t, { scope: "acme", pack: "b", archive: GOOD() });
    const first = await rulesPass(t.rt);
    expect(first.completed).toBe(false);
    const second = await rulesPass(t.rt);
    const third = await rulesPass(t.rt);
    expect([first.visited, second.visited, third.visited].reduce((a, b) => a + b, 0)).toBe(1);
    expect(third.completed).toBe(true);
    expect(state(t, "v-acme-a-1.0.0").score_rules_version).toBe("2026.10.1");
    expect(state(t, "v-acme-b-1.0.0").score_rules_version).toBe("2026.10.2");
  });
});

describe("the domain pass", () => {
  const install = link("https://install.example.com/toolkit", "install");
  const prose = link("https://docs.example.org/guide", "prose");

  async function setup() {
    const t = await testRuntime();
    t.fakes.dns.hosts.add("install.example.com");
    t.fakes.dns.hosts.add("docs.example.org");
    const installer = await publish(t, { scope: "acme", pack: "installer", archive: GOOD(INSTALL_README), urls: [install], rules: "2026.10.2" });
    const notes = await publish(t, { scope: "acme", pack: "notes", archive: GOOD(PROSE_README), urls: [prose], rules: "2026.10.2" });
    owner(t, "acme");
    return { t, installer, notes };
  }

  it("records a baseline the first time and finds nothing", async () => {
    const { t, installer, notes } = await setup();
    const progress = await domainsPass(t.rt);
    expect(progress).toMatchObject({ kind: "domains", visited: 2, findings: 0, completed: true });
    expect(state(t, installer.id).state).toBe("active");
    expect(state(t, notes.id).state).toBe("active");
    expect(t.fakes.mail.sent).toEqual([]);
  });

  it("quarantines for an install domain that stopped resolving and warns and mails for ordinary prose, once", async () => {
    const { t, installer, notes } = await setup();
    await domainsPass(t.rt);
    t.fakes.dns.hosts.clear();
    t.fakes.clock.advance("7d");
    const progress = await domainsPass(t.rt);
    expect(progress).toMatchObject({ visited: 2, findings: 2, completed: true });
    expect(state(t, installer.id)).toMatchObject({ state: "quarantined", status_reason: "domain-drift" });
    expect(state(t, notes.id).state).toBe("active");
    expect(t.db.prepare(`select version_id, kind, subject from version_warnings order by subject`).all()).toEqual([
      { version_id: notes.id, kind: "domain-drift", subject: "docs.example.org" },
      { version_id: installer.id, kind: "domain-drift", subject: "install.example.com" },
    ]);
    expect(t.fakes.mail.sent.map((m) => [m.to, m.subject])).toEqual([["owner@example.test", "A link in @acme/notes 1.0.0 now resolves differently"]]);
    expect(reindexed(t)).toHaveLength(1);

    await domainsPass(t.rt);
    expect(t.fakes.mail.sent).toHaveLength(1);
  });

  it("finds a domain that began resolving as changed too, and does not repeat the finding the next week", async () => {
    const t = await testRuntime();
    await publish(t, { scope: "acme", pack: "installer", archive: GOOD(INSTALL_README), urls: [install], rules: "2026.10.2" });
    await domainsPass(t.rt);
    t.fakes.dns.hosts.add("install.example.com");
    t.fakes.clock.advance("7d");
    expect((await domainsPass(t.rt)).findings).toBe(1);
    t.db.prepare(`update pack_versions set state = 'active', status_reason = null`).run();
    t.fakes.clock.advance("7d");
    expect((await domainsPass(t.rt)).findings).toBe(0);
    expect(state(t, "v-acme-installer-1.0.0").state).toBe("active");
  });

  it("stops the fire when the resolver cannot be reached: nothing is recorded or quarantined, and the pass resumes", async () => {
    const { t, installer } = await setup();
    await domainsPass(t.rt);
    t.fakes.clock.advance("7d");
    t.fakes.dns.hosts.clear();
    const resolves = t.fakes.dns.resolves.bind(t.fakes.dns);
    t.fakes.dns.resolves = async () => {
      throw new PortError("dns_unavailable", "down");
    };
    expect(await domainsPass(t.rt)).toMatchObject({ visited: 0, completed: false });
    expect(state(t, installer.id).state).toBe("active");
    t.fakes.dns.resolves = resolves;
    expect((await domainsPass(t.rt)).findings).toBe(2);
    expect(state(t, installer.id).state).toBe("quarantined");
  });

  it("records nothing for a name the resolver fails on, keeps going to the packs after it, and asks the name again next time", async () => {
    const t = await testRuntime();
    const broken = link("https://broken.example.net/x", "prose");
    for (const host of ["install.example.com", "docs.example.org", "broken.example.net"]) t.fakes.dns.hosts.add(host);
    const first = await publish(t, { scope: "acme", pack: "a", archive: GOOD(INSTALL_README), urls: [install], rules: "2026.10.2" });
    const middle = await publish(t, { scope: "acme", pack: "b", archive: GOOD(PROSE_README), urls: [broken, prose], rules: "2026.10.2" });
    const last = await publish(t, { scope: "acme", pack: "c", archive: GOOD(INSTALL_README), urls: [install], rules: "2026.10.2" });
    owner(t, "acme");
    await domainsPass(t.rt);
    t.fakes.clock.advance("7d");
    t.fakes.dns.hosts.clear();
    const resolves = t.fakes.dns.resolves.bind(t.fakes.dns);
    t.fakes.dns.resolves = async (name: string) => {
      if (name === "broken.example.net") throw new PortError(DNS_NAME_UNANSWERED, "the resolver reported status 2");
      return resolves(name);
    };
    const week = await domainsPass(t.rt);
    expect(week).toMatchObject({ visited: 3, completed: true });
    expect(state(t, first.id).state).toBe("quarantined");
    expect(state(t, last.id).state).toBe("quarantined");
    expect(state(t, middle.id).state).toBe("active");
    expect(t.db.prepare(`select checked_trigger from url_domain_states where domain = 'broken.example.net'`).get()).not.toEqual({ checked_trigger: weekOf(t.rt.ports.clock.now()) });
    expect(t.db.prepare(`select count(*) as n from version_warnings where subject = 'broken.example.net'`).get()).toEqual({ n: 0 });
    expect(t.db.prepare(`select count(*) as n from version_warnings where subject = 'docs.example.org'`).get()).toEqual({ n: 1 });
  });

  it("reads a worst-case page's domain states in chunks and stays inside its query budget", async () => {
    const t = await testRuntime();
    (t.rt.config as { rescanBatch: () => number }).rescanBatch = () => 50;
    for (let p = 0; p < 50; p++) {
      const urls = Array.from({ length: 100 }, (_, n) => link(`https://p${p}-d${n}.example.org/x`, "prose"));
      await publish(t, { scope: "acme", pack: `p${p}`, archive: GOOD(), urls, rules: "2026.10.2" });
    }
    const trigger = weekOf(t.rt.ports.clock.now());
    const insert = t.db.prepare(`insert into url_domain_states (domain, resolves, checked_trigger, changed_trigger, updated_at) values (?, 1, ?, null, 'x')`);
    for (let p = 0; p < 50; p++) for (let n = 0; n < 100; n++) insert.run(`p${p}-d${n}.example.org`, trigger);
    let statements = 0;
    const query = t.rt.ports.d1.query.bind(t.rt.ports.d1);
    const batch = t.rt.ports.d1.batch.bind(t.rt.ports.d1);
    t.rt.ports.d1.query = async (...args: Parameters<typeof query>) => (statements++, query(...args));
    t.rt.ports.d1.batch = async (...args: Parameters<typeof batch>) => (statements++, batch(...args));
    const progress = await domainsPass(t.rt);
    expect(progress).toMatchObject({ visited: 50 });
    expect(statements).toBeLessThan(DOMAIN_BUDGET.queries);
  });

  it("stops the page cleanly when its query budget is spent and resumes at the next pack", async () => {
    const t = await testRuntime();
    for (const pack of ["a", "b", "c"]) await publish(t, { scope: "acme", pack, archive: GOOD(), urls: [link(`https://${pack}.example.org/x`, "prose")], rules: "2026.10.2" });
    owner(t, "acme");
    for (const pack of ["a", "b", "c"]) t.fakes.dns.hosts.add(`${pack}.example.org`);
    const original = DOMAIN_BUDGET.queries;
    DOMAIN_BUDGET.queries = 14;
    try {
      const first = await domainsPass(t.rt);
      expect(first.completed).toBe(false);
      expect(first.visited).toBeLessThan(3);
    } finally {
      DOMAIN_BUDGET.queries = original;
    }
    const rest = await domainsPass(t.rt);
    expect(rest.completed).toBe(true);
    expect(t.db.prepare(`select count(*) as n from url_domain_states`).get()).toEqual({ n: 3 });
  });

  it("stops at the lookup budget and picks up at the pack it had not reached", async () => {
    const t = await testRuntime();
    const many = Array.from({ length: 40 }, (_, n) => link(`https://site${n}.example.org/x`, "prose"));
    for (const pack of ["a", "b", "c", "d"]) {
      for (const l of many) t.fakes.dns.hosts.add(l.domain);
      await publish(t, { scope: "acme", pack, archive: GOOD(), urls: many.map((l) => ({ ...l, domain: `${pack}-${l.domain}`, url: `https://${pack}-${l.domain}/x` })), rules: "2026.10.2" });
      for (const l of many) t.fakes.dns.hosts.add(`${pack}-${l.domain}`);
    }
    const first = await domainsPass(t.rt);
    expect(first.completed).toBe(false);
    expect(first.visited).toBeLessThan(4);
    let rounds = 0;
    for (let last = first; !last.completed && rounds < 6; rounds++) last = await domainsPass(t.rt);
    expect(rounds).toBeLessThan(6);
    expect(t.db.prepare(`select count(*) as n from url_domain_states`).get()).toEqual({ n: 160 });
  });
});

describe("the full-pipeline pass", () => {
  async function declared(t: Runtime, packs: Array<[string, number]>) {
    t.db.exec(`insert into adoption_scans (id, started_at, updated_at, completed_at) values ('scan', 'x', 'x', 'x')`);
    for (const [pack, n] of packs) for (let r = 0; r < n; r++) t.db.prepare(`insert into pack_declarations (scan_id, pack, repository, owner, settings_path) values ('scan', ?, ?, 'o', 's.yml')`).run(pack, `${pack}-${r}`);
  }

  it("does not begin before an adoption scan has completed", async () => {
    const t = await testRuntime();
    await publish(t, { scope: "acme", pack: "gcp", archive: GOOD(), rules: "2026.10.2" });
    expect(await pipelinePass(t.rt)).toMatchObject({ visited: 0, completed: false });
    expect(t.db.prepare(`select count(*) as n from rescan_passes where kind = 'pipeline'`).get()).toEqual({ n: 0 });
  });

  it("starts one dry-run per declared pack, once a week, for the newest eligible version", async () => {
    const t = await testRuntime();
    await publish(t, { scope: "acme", pack: "popular", archive: GOOD(), rules: "2026.10.2" });
    await publish(t, { scope: "acme", pack: "obscure", archive: GOOD(), rules: "2026.10.2" });
    await publish(t, { scope: "acme", pack: "nobody", archive: GOOD(), rules: "2026.10.2" });
    await declared(t, [["@acme/popular", 3], ["@acme/obscure", 1], ["@acme/gone", 9]]);
    const progress = await pipelinePass(t.rt);
    expect(progress).toMatchObject({ kind: "pipeline", visited: 2, completed: true });
    const runs = t.db.prepare(`select id, kind, principal, pack_name, version, staging_key, declared_sha256, status from validation_runs order by pack_name`).all() as Array<Record<string, unknown>>;
    expect(runs.map((r) => [r.pack_name, r.kind, r.principal, r.status])).toEqual([["obscure", "dry-run", RESCAN_PRINCIPAL, "running"], ["popular", "dry-run", RESCAN_PRINCIPAL, "running"]]);
    expect(runs[1]!.staging_key).toBe("rescan:public:@acme/popular/1.0.0/pack.tar.zst");
    expect([...t.fakes.workflows["VALIDATE_PACK"]!.instances.keys()].sort()).toEqual(runs.map((r) => r.id).sort());
    expect(t.db.prepare(`select count(*) as n from rescan_runs where applied_at is null`).get()).toEqual({ n: 2 });

    expect((await pipelinePass(t.rt)).visited).toBe(0);
    t.fakes.clock.advance("7d");
    await pipelinePass(t.rt);
    expect(t.db.prepare(`select count(*) as n from validation_runs`).get()).toEqual({ n: 4 });
  });

  it("starts at most a thousand", async () => {
    const t = await testRuntime();
    (t.rt.config as { rescanBatch: () => number }).rescanBatch = () => 90;
    t.db.exec(`insert into adoption_scans (id, started_at, updated_at, completed_at) values ('scan', 'x', 'x', 'x')`);
    t.db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s-m', 'm', 'org', 'active', 'x')`);
    const insertPack = t.db.prepare(`insert into packs (id, scope_id, name, visibility, created_at) values (?, 's-m', ?, 'public', 'x')`);
    const insertVersion = t.db.prepare(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values (?, ?, '1.0.0', 'active', ?, 1, 'x', 0, 0)`);
    const insertDecl = t.db.prepare(`insert into pack_declarations (scan_id, pack, repository, owner, settings_path) values ('scan', ?, 'r', 'o', 's.yml')`);
    t.db.exec("begin");
    for (let n = 0; n < 1_050; n++) {
      insertPack.run(`p${n}`, `pk${String(n).padStart(4, "0")}`);
      insertVersion.run(`v${n}`, `p${n}`, "a".repeat(64));
      insertDecl.run(`@m/pk${String(n).padStart(4, "0")}`);
    }
    t.db.exec("commit");
    let started = 0;
    for (let page = await pipelinePass(t.rt); ; page = await pipelinePass(t.rt)) {
      started += page.visited;
      if (page.completed) break;
    }
    expect(started).toBe(1_000);
  });

  it("applies a finished run's verdict: a fail quarantines, a hold the original report carried does not, an error waits for next week", async () => {
    const t = await testRuntime();
    const failing = await publish(t, { scope: "acme", pack: "failing", archive: GOOD(), rules: "2026.10.2" });
    const holding = await publish(t, { scope: "acme", pack: "holding", archive: GOOD(), rules: "2026.10.2" });
    const broken = await publish(t, { scope: "acme", pack: "broken", archive: GOOD(), rules: "2026.10.2" });
    await declared(t, [["@acme/failing", 1], ["@acme/holding", 1], ["@acme/broken", 1]]);
    await pipelinePass(t.rt);

    const finding = (rule: string, cls: string) => ({ rule, class: cls, file: "README.md", line: 3, quote: null, hint: "x" });
    const finish = async (pack: string, verdict: string, findings: unknown[]) => {
      const run = t.db.prepare(`select id from validation_runs where pack_name = ?`).get(pack) as { id: string };
      const report = { run_id: run.id, pack: `@acme/${pack}`, version: "1.0.0", rules_version: "2026.10.2", started_at: "2026-10-22T12:00:00.000Z", finished_at: "2026-10-22T12:01:00.000Z", verdict, steps: [{ step: 8, name: "load", outcome: "fail", ms: 1 }], findings, tree_hash: null, canonical_sha256: null, source_verified: false, prose_screen: null, score: null };
      await t.fakes.r2["VALIDATION_REPORTS"]!.put(`runs/${run.id}/report.json`, new TextEncoder().encode(JSON.stringify(report)));
      t.db.prepare(`update validation_runs set status = 'finished', verdict = ?, reason = ?, report_key = ? where id = ?`).run(verdict, verdict === "error" ? "sandbox.a_failed" : null, verdict === "error" ? null : `runs/${run.id}/report.json`, run.id);
    };
    await finish("failing", "fail", [finding("load.failed", "fail")]);
    await finish("holding", "hold", [finding("text.url-install", "hold")]);
    await finish("broken", "error", []);
    const baseline = { run_id: "old", pack: "@acme/holding", version: "1.0.0", rules_version: "2026.10.1", started_at: "2026-10-22T12:00:00.000Z", finished_at: "2026-10-22T12:01:00.000Z", verdict: "hold", steps: [], findings: [finding("text.url-install", "hold")], tree_hash: null, canonical_sha256: null, source_verified: false, prose_screen: null, score: null };
    await t.fakes.r2["VALIDATION_REPORTS"]!.put("runs/old/report.json", new TextEncoder().encode(JSON.stringify(baseline)));
    t.db.prepare(`update pack_versions set report_key = 'runs/old/report.json' where id = ?`).run(holding.id);

    const progress = await collect(t.rt);
    expect(progress).toMatchObject({ kind: "collect", visited: 3, findings: 1 });
    expect(state(t, failing.id)).toMatchObject({ state: "quarantined", status_reason: "load.failed" });
    expect(state(t, holding.id).state).toBe("active");
    expect(state(t, broken.id).state).toBe("active");
    expect((await collect(t.rt)).completed).toBe(true);
  });
});

describe("a scheduled fire and the internal route", () => {
  it("advances the collection, the rules pass and one weekly pass per fire, alternating, and one failing does not stop the others", async () => {
    const t = await testRuntime();
    await publish(t, { scope: "acme", pack: "gcp", archive: GOOD(), urls: [link("https://docs.example.org/guide", "prose")] });
    t.fakes.dns.resolves = async () => {
      throw new PortError("dns_unavailable", "down");
    };
    const first = await tick(t.rt);
    t.fakes.clock.advance("15m");
    const second = await tick(t.rt);
    expect(first.map((p) => p.kind)).toEqual(["collect", "rules", expect.stringMatching(/^(domains|pipeline)$/)]);
    expect(new Set([first[2]?.kind, second[2]?.kind])).toEqual(new Set(["domains", "pipeline"]));
    expect(state(t, "v-acme-gcp-1.0.0").score_rules_version).toBe("2026.10.2");
  });

  it("emits rescan.completed once when two fires overlap on the same pass", async () => {
    const t = await testRuntime();
    await publish(t, { scope: "acme", pack: "gcp", archive: GOOD() });
    await Promise.all([rulesPass(t.rt), rulesPass(t.rt)]);
    expect(t.fakes.stats.points.filter((p) => p.name === "rescan.completed")).toHaveLength(1);
  });

  it("rescans a version promoted under older rules after the sweep ended", async () => {
    const t = await testRuntime();
    await publish(t, { scope: "acme", pack: "early", archive: GOOD() });
    await rulesPass(t.rt);
    t.fakes.clock.advance("1h");
    const late = await publish(t, { scope: "acme", pack: "late", archive: GOOD() });
    t.db.prepare(`update pack_versions set published_at = ? where id = ?`).run(new Date(t.rt.ports.clock.now()).toISOString(), late.id);
    expect(state(t, late.id).score_rules_version).toBe("2026.10.1");
    expect(await rulesPass(t.rt)).toMatchObject({ visited: 1, completed: true });
    expect(state(t, late.id).score_rules_version).toBe("2026.10.2");
    expect(await rulesPass(t.rt)).toMatchObject({ visited: 0 });
    expect(t.fakes.stats.points.filter((p) => p.name === "rescan.completed")).toHaveLength(1);
  });

  it("runs a pass to its end for the operator and refuses what it does not know", async () => {
    const t = await testRuntime();
    (t.rt.config as { rescanBatch: () => number }).rescanBatch = () => 1;
    for (const pack of ["a", "b", "c"]) await publish(t, { scope: "acme", pack, archive: GOOD() });
    const reply = async (body: unknown) => {
      const { Hono } = await import("hono");
      const app = new Hono();
      app.post("/", rescanRoute(t.rt));
      return app.request("/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    };
    const pages: Array<{ visited: number; completed: boolean }> = [];
    for (let i = 0; i < 6 && !pages.at(-1)?.completed; i++) pages.push((await (await reply({ job: "rules" })).json()) as { visited: number; completed: boolean });
    expect(pages.map((p) => p.visited)).toEqual([1, 1, 1, 0]);
    expect(pages.at(-1)?.completed).toBe(true);
    expect((await reply({ job: "nothing" })).status).toBe(400);
  });
});
