import { describe, expect, it } from "vitest";
import { FakeDns, FakeMail, FakeQueue, FakeWellKnown } from "@packserver/ports/fakes";
import { migratedD1 } from "../../identity/testing.ts";
import {
  applicationOf, applyForVerified, checkDomainProof, createOrg, decideApplication, domainProofsOf, githubProofOf, judgeDomain, loadProfile, loadScope, mayReassign,
  pendingApplications, pendingApplicationsFor, proveGithubOrg, recheckDomains, registrableLabel, revokeVerified, startDomainProof, sweepGithubProofs,
  verificationFacts, personalScopeStatements, type ProofPorts, type ScopeRow,
} from "../index.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-23T00:00:00.000Z");

function world() {
  const { d1, db } = migratedD1();
  let now = T0;
  let n = 0;
  const dns = new FakeDns();
  const wellKnown = new FakeWellKnown();
  const mail = new FakeMail();
  const reindex = new FakeQueue();
  const ports: ProofPorts = {
    d1,
    clock: { now: () => now },
    rng: { float: () => 0.5, uuid: () => crypto.randomUUID(), bytes: (len) => Uint8Array.from({ length: len }, () => ++n & 255) },
    dns, wellKnown, mail, reindex,
    siteOrigin: "https://registry.test",
  };
  const stamp = () => new Date(now).toISOString();
  const person = async (id: string, handle: string, email = `${handle}@example.test`) => {
    db.exec(`insert into users (id, handle, created_at) values ('${id}', '${handle}', '${stamp()}')`);
    await d1.batch(personalScopeStatements(ports, id, handle));
    db.exec(`insert into user_emails (user_id, address, source, created_at) values ('${id}', '${email}', 'github', '${stamp()}')`);
  };
  const org = async (userId: string, name: string): Promise<ScopeRow> => {
    const made = await createOrg(ports, userId, name);
    if (!made.ok) throw new Error(made.message);
    return made.scope;
  };
  const prove = async (scope: ScopeRow, domain: string, via: "txt" | "file" = "txt") => {
    const started = await startDomainProof(ports, scope, domain);
    if (!started.ok) throw new Error(started.message);
    if (via === "txt") dns.txt.set(started.challenge.txt.name, [started.challenge.txt.value]);
    else wellKnown.files.set(domain, { status: "found", body: `${started.challenge.token}\n` });
    return { started: started.challenge, checked: await checkDomainProof(ports, (await loadScope(d1, scope.name))!, started.challenge.id) };
  };
  return { ports, d1, db, dns, wellKnown, mail, reindex, person, org, prove, advance: (ms: number) => (now += ms), at: () => now, fresh: (name: string) => loadScope(d1, name).then((s) => s!) };
}

describe("judgeDomain (REQ-SCOPE-005)", () => {
  it("refuses a public suffix, a bare TLD and a host that is not one", () => {
    for (const bad of ["github.io", "co.uk", "com", "pages.dev", "blogspot.com", "GitHub.IO."]) expect(judgeDomain(bad), bad).toMatchObject({ ok: false, reason: "public_suffix" });
    for (const bad of ["", "http://acme.com", "acme.com/x", "acme.com:80", "127.0.0.1", "a b.com", "-a.com"]) expect(judgeDomain(bad), bad).toMatchObject({ ok: false, reason: "format" });
  });
  it("accepts a subdomain as itself and a registrable name under a registry second level", () => {
    expect(judgeDomain("Docs.Acme.com.")).toEqual({ ok: true, domain: "docs.acme.com" });
    expect(judgeDomain("acme.co.uk")).toEqual({ ok: true, domain: "acme.co.uk" });
    expect(judgeDomain("acme.github.io")).toEqual({ ok: true, domain: "acme.github.io" });
  });
  it("follows the Public Suffix List, wildcard and exception rules included", () => {
    for (const suffix of ["readthedocs.io", "blogspot.com", "gitbook.io", "pythonanywhere.com", "s3.eu-west-1.amazonaws.com", "foo.compute.amazonaws.com", "bar.kobe.jp", "xn--p1ai"]) {
      expect(judgeDomain(suffix), suffix).toMatchObject({ ok: false, reason: "public_suffix" });
    }
    expect(judgeDomain("city.kobe.jp")).toEqual({ ok: true, domain: "city.kobe.jp" });
    expect(judgeDomain("me.readthedocs.io")).toEqual({ ok: true, domain: "me.readthedocs.io" });
    expect([registrableLabel("me.readthedocs.io"), registrableLabel("x.blogspot.com"), registrableLabel("a.bar.kobe.jp"), registrableLabel("www.city.kobe.jp")]).toEqual(["me", "x", "a", "city"]);
  });

  it("refuses every spelling of an IP address and converts a Unicode name to punycode", () => {
    for (const bad of ["0x7f.1", "0x7f.0.0.1", "127.1", "2130706433", "017700000001.1", "1.2.3.4", "[::1]"]) expect(judgeDomain(bad), bad).toMatchObject({ ok: false, reason: "format" });
    expect(judgeDomain("bücher.de")).toEqual({ ok: true, domain: "xn--bcher-kva.de" });
  });

  it("names the label registered under the suffix", () => {
    expect([registrableLabel("docs.acme.com"), registrableLabel("acme.co.uk"), registrableLabel("acme.com")]).toEqual(["acme", "acme", "acme"]);
  });
});

describe("domain proof by TXT or .well-known (REQ-SCOPE-004)", () => {
  it("proves by the TXT record, then by the file, and shows the full host", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    const acme = await w.org("u1", "acme");
    const beta = await w.org("u2", "beta");
    const a = await w.prove(acme, "docs.acme.com");
    expect(a.checked).toMatchObject({ status: "verified", method: "txt", transferred: false });
    const b = await w.prove(beta, "beta.example", "file");
    expect(b.checked).toMatchObject({ status: "verified", method: "well-known" });
    expect((await loadProfile(w.d1, "acme"))!.mark.text).toBe("● docs.acme.com");
    expect((await loadProfile(w.d1, "beta"))!.verified_domain).toBe("beta.example");
    expect(w.reindex.messages).toEqual(expect.arrayContaining([{ schema: 1, type: "scope.proof_changed", scope: "acme", change: "domain_verified" }]));
  });

  it("leaves the scope unproven when the record holds another token", async () => {
    const w = world();
    await w.person("u1", "ann");
    const acme = await w.org("u1", "acme");
    const started = (await startDomainProof(w.ports, acme, "acme.com")) as { ok: true; challenge: { id: string; txt: { name: string } } };
    w.dns.txt.set(started.challenge.txt.name, ["packserver-someone-else"]);
    expect(await checkDomainProof(w.ports, acme, started.challenge.id)).toMatchObject({ status: "mismatch" });
    expect((await loadScope(w.d1, "acme"))!.verified_domain).toBeNull();
    expect(w.reindex.messages).toEqual([]);
  });

  it("refuses a public suffix before any lookup, and a second domain for a scope that holds one", async () => {
    const w = world();
    await w.person("u1", "ann");
    const acme = await w.org("u1", "acme");
    expect(await startDomainProof(w.ports, acme, "github.io")).toMatchObject({ ok: false, reason: "public_suffix" });
    expect(w.wellKnown.fetched).toEqual([]);
    await w.prove(acme, "acme.com");
    expect(await startDomainProof(w.ports, acme, "other.com")).toMatchObject({ ok: false, reason: "has_domain" });
    expect(await startDomainProof(w.ports, acme, "acme.com")).toMatchObject({ ok: true });
  });

  it("returns the same challenge for the same scope and domain", async () => {
    const w = world();
    await w.person("u1", "ann");
    const acme = await w.org("u1", "acme");
    const one = (await startDomainProof(w.ports, acme, "acme.com")) as { ok: true; challenge: { token: string } };
    const two = (await startDomainProof(w.ports, acme, "ACME.com")) as { ok: true; challenge: { token: string } };
    expect(two.challenge.token).toBe(one.challenge.token);
    expect((await domainProofsOf(w.ports, acme.id)).pending).toHaveLength(1);
  });

  it("does not take a resolver outage for a missing record", async () => {
    const w = world();
    await w.person("u1", "ann");
    const acme = await w.org("u1", "acme");
    const started = (await startDomainProof(w.ports, acme, "acme.com")) as { ok: true; challenge: { id: string } };
    w.dns.resolveTxt = async () => {
      throw new Error("resolver down");
    };
    w.wellKnown.files.set("acme.com", { status: "absent", reason: "unreachable" });
    expect(await checkDomainProof(w.ports, acme, started.challenge.id)).toMatchObject({ status: "unreachable" });
  });

  it("fails on a redirected or oversized file and fetches only the claimed host", async () => {
    const w = world();
    await w.person("u1", "ann");
    const acme = await w.org("u1", "acme");
    const started = (await startDomainProof(w.ports, acme, "acme.com")) as { ok: true; challenge: { id: string } };
    w.wellKnown.files.set("acme.com", { status: "absent", reason: "redirected" });
    expect(await checkDomainProof(w.ports, acme, started.challenge.id)).toMatchObject({ status: "missing", detail: "redirected" });
    w.wellKnown.files.set("acme.com", { status: "absent", reason: "too_large" });
    expect(await checkDomainProof(w.ports, acme, started.challenge.id)).toMatchObject({ status: "missing", detail: "too_large" });
    expect(w.wellKnown.fetched).toEqual(["acme.com", "acme.com"]);
  });
});

describe("domain proof is re-checked and lapses with a warning (REQ-SCOPE-006)", () => {
  it("keeps a proof whose record stays and removes one that fails for 30 days, warning first", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    const acme = await w.org("u1", "acme");
    const beta = await w.org("u2", "beta");
    await w.prove(acme, "acme.com");
    const b = await w.prove(beta, "beta.com");
    w.dns.txt.delete(b.started.txt.name);

    w.advance(29 * DAY);
    expect(await recheckDomains(w.ports)).toMatchObject({ checked: 0 });
    w.advance(DAY);
    expect(await recheckDomains(w.ports)).toMatchObject({ checked: 2, kept: 1, warned: 1, lapsed: 0 });
    expect((await loadScope(w.d1, "beta"))!.verified_domain).toBe("beta.com");
    expect(w.mail.inbox("bob@example.test").map((m) => m.subject)).toEqual(["Domain proof for beta is failing"]);
    expect(w.mail.inbox("bob@example.test")[0]!.text).toContain("2026-12-22");
    expect(w.mail.inbox("ann@example.test")).toEqual([]);

    w.advance(15 * DAY);
    expect(await recheckDomains(w.ports)).toMatchObject({ checked: 0 });
    w.advance(15 * DAY);
    expect(await recheckDomains(w.ports)).toMatchObject({ checked: 2, kept: 1, warned: 0, lapsed: 1 });
    expect((await loadScope(w.d1, "beta"))!.verified_domain).toBeNull();
    expect((await loadScope(w.d1, "acme"))!.verified_domain).toBe("acme.com");
    expect(w.mail.inbox("bob@example.test")).toHaveLength(1);
    expect(w.reindex.messages).toEqual(expect.arrayContaining([{ schema: 1, type: "scope.proof_changed", scope: "beta", change: "domain_lapsed" }]));
  });

  it("forgets a failure when the record comes back, and leaves a proof alone while the resolver is down", async () => {
    const w = world();
    await w.person("u1", "ann");
    const acme = await w.org("u1", "acme");
    const p = await w.prove(acme, "acme.com");
    w.dns.txt.delete(p.started.txt.name);
    w.advance(30 * DAY);
    await recheckDomains(w.ports);
    w.dns.txt.set(p.started.txt.name, [p.started.token]);
    w.advance(30 * DAY);
    expect(await recheckDomains(w.ports)).toMatchObject({ kept: 1, lapsed: 0 });
    expect((await w.d1.query("select failed_since, warned_at from domain_challenges")).rows).toEqual([{ failed_since: null, warned_at: null }]);

    w.dns.resolveTxt = async () => {
      throw new Error("resolver down");
    };
    w.wellKnown.files.set("acme.com", { status: "absent", reason: "unreachable" });
    w.advance(90 * DAY);
    expect(await recheckDomains(w.ports)).toMatchObject({ skipped: 1, lapsed: 0 });
    expect((await loadScope(w.d1, "acme"))!.verified_domain).toBe("acme.com");
  });
});

describe("a re-check moves only the proof (REQ-SCOPE-007)", () => {
  it("gives the proof to the scope the record names, keeps everything else, and marks the transfer", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    const a = await w.org("u1", "acme");
    const b = await w.org("u2", "beta");
    await w.prove(a, "acme.com");
    w.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('pk1', '${a.id}', 'gcp', 'public', '${new Date(T0).toISOString()}')`);
    w.advance(10 * DAY);
    const moved = await w.prove(b, "acme.com");
    expect(moved.checked).toMatchObject({ status: "verified", transferred: true, movedFrom: "acme" });
    const [pa, pb] = [(await loadProfile(w.d1, "acme"))!, (await loadProfile(w.d1, "beta"))!];
    expect([pa.verified_domain, pb.verified_domain]).toEqual([null, "acme.com"]);
    expect(pb.verified_domain_transferred_at).toBe(new Date(T0 + 10 * DAY).toISOString());
    expect(pa.verified_domain_transferred_at).toBeNull();
    expect((await w.d1.query("select name from packs where scope_id = ?", [a.id])).rows).toHaveLength(1);
    expect((await w.d1.query("select role from scope_members where scope_id = ?", [a.id])).rows).toEqual([{ role: "owner" }]);
    expect(w.mail.inbox("ann@example.test").map((m) => m.subject)).toEqual(["acme.com is no longer verified for acme"]);
    expect(w.mail.inbox("bob@example.test")).toEqual([]);
    expect(w.reindex.messages.map((m) => (m as { scope: string; change: string }).change + ":" + (m as { scope: string }).scope)).toEqual(
      expect.arrayContaining(["domain_moved:acme", "domain_verified:beta"]),
    );
  });

  it("marks a domain gained within a year of another holder's loss, and no other", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    const a = await w.org("u1", "acme");
    const b = await w.org("u2", "beta");
    const p = await w.prove(a, "acme.com");
    w.dns.txt.delete(p.started.txt.name);
    w.advance(30 * DAY);
    await recheckDomains(w.ports);
    w.advance(30 * DAY);
    await recheckDomains(w.ports);
    expect((await loadScope(w.d1, "acme"))!.verified_domain).toBeNull();
    w.advance(100 * DAY);
    expect((await w.prove(b, "acme.com")).checked).toMatchObject({ status: "verified", transferred: true, movedFrom: null });

    const c = await w.org("u1", "gamma");
    expect((await w.prove(c, "gamma.com")).checked).toMatchObject({ transferred: false });
    expect((await verificationFacts(w.d1, c.id))!.verified_domain_transferred_at).toBeNull();

    const d = await w.org("u2", "delta");
    const q = await w.prove(c, "gamma.com");
    expect(q.checked).toMatchObject({ transferred: false });
    w.advance(400 * DAY);
    w.dns.txt.delete("_packserver-challenge.gamma.com");
    const old = await startDomainProof(w.ports, d, "old.com");
    expect(old.ok).toBe(true);
  });
});

describe("a domain proof holds a colliding name and never takes it (REQ-SCOPE-011)", () => {
  it("holds a scope with no promoted version, only marks one with versions, and guards reassignment", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    await w.person("u3", "cy");
    const squat = await w.org("u1", "acme");
    const live = await w.org("u2", "acmeinc");
    const r = await w.org("u3", "real");
    w.db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('pk1', '${live.id}', 'gcp', 'public', '${new Date(T0).toISOString()}')`);
    w.db.exec(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values ('v1', 'pk1', '1.0.0', 'active', 'abc', 1, '${new Date(T0).toISOString()}', 0, 0)`);

    await w.prove(r, "acme.com");
    expect((await loadScope(w.d1, "acme"))!.state).toBe("held");
    expect((await loadProfile(w.d1, "acme"))!.disputed).toMatchObject({ domain: "acme.com" });
    expect(w.mail.inbox("ann@example.test")[0]!.text).toContain("cannot publish");

    const r2 = await w.org("u3", "omega");
    await w.prove(r2, "acmeinc.com");
    expect((await loadScope(w.d1, "acmeinc"))!.state).toBe("active");
    expect((await loadProfile(w.d1, "acmeinc"))!.disputed).toMatchObject({ domain: "acmeinc.com" });
    expect(w.mail.inbox("bob@example.test")[0]!.text).toContain("keeps its name");

    expect(await mayReassign(w.d1, live.id, false)).toMatchObject({ ok: false, reason: "has_promoted_versions" });
    expect(await mayReassign(w.d1, live.id, true)).toEqual({ ok: true });
    expect(await mayReassign(w.d1, squat.id, false)).toEqual({ ok: true });
  });

  it("leaves the scope that holds the domain itself undisputed", async () => {
    const w = world();
    await w.person("u1", "ann");
    const acme = await w.org("u1", "acme");
    await w.prove(acme, "acme.com");
    expect((await loadProfile(w.d1, "acme"))!.disputed).toBeNull();
    expect((await loadScope(w.d1, "acme"))!.state).toBe("active");
  });
});

describe("GitHub organisation proof (REQ-SCOPE-008, REQ-SCOPE-009)", () => {
  const ORG_IDS: Record<string, number> = { acme: 101, gamma: 102, beta: 103, gone: 104, other: 105, susp: 106 };
  const orgId = (login: string): number => ORG_IDS[login.toLowerCase()]!;
  const install = (w: ReturnType<typeof world>, id: number, login: string, sender: string, status = "active", uninstalled: string | null = null) =>
    w.db.exec(
      `insert into github_installations (installation_id, account_id, account_login, account_type, sender_login, repository_selection, status, installed_at, uninstalled_at, updated_at)
       values (${id}, ${orgId(login)}, '${login}', 'Organization', '${sender}', 'all', '${status}', '${new Date(T0).toISOString()}', ${uninstalled ? `'${uninstalled}'` : "null"}, '${new Date(T0).toISOString()}')`,
    );
  const github = (w: ReturnType<typeof world>, userId: string, login: string, adminOf: string[]) => {
    w.db.exec(`insert into identities (id, user_id, provider, provider_user_id, login, created_at) values ('i-${userId}', '${userId}', 'github', 'gh-${userId}', '${login}', '${new Date(T0).toISOString()}')`);
    for (const org of adminOf) w.db.exec(`insert into github_org_admins (user_id, github_org_id, github_org_login, observed_at) values ('${userId}', '${orgId(org)}', '${org}', '${new Date(T0).toISOString()}')`);
  };

  it("accepts an App installed by an owner and an owner's sign-in, and refuses an installer who is not an owner", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    await w.person("u3", "cy");
    github(w, "u1", "ann-gh", ["Acme"]);
    github(w, "u3", "cy-gh", ["beta"]);
    github(w, "u2", "bob-gh", []);
    install(w, 1, "Acme", "ann-gh");
    install(w, 2, "gamma", "bob-gh");
    const acme = await w.org("u1", "acme");
    const beta = await w.org("u3", "betaorg");
    const gamma = await w.org("u2", "gammaorg");

    expect(await proveGithubOrg(w.ports, beta, "u3", { org: "acme", method: "app" })).toMatchObject({ ok: false, reason: "not_org_admin" });
    expect((await loadScope(w.d1, "betaorg"))!.verified_github_org).toBeNull();
    expect(await proveGithubOrg(w.ports, acme, "u1", { org: "acme", method: "app" })).toEqual({ ok: true, org: "Acme", method: "app" });
    expect(await proveGithubOrg(w.ports, beta, "u3", { org: "BETA", method: "admin" })).toEqual({ ok: true, org: "beta", method: "admin" });
    expect(await proveGithubOrg(w.ports, gamma, "u2", { org: "gamma", method: "app" })).toMatchObject({ ok: false, reason: "installer_not_owner" });
    expect(await proveGithubOrg(w.ports, gamma, "u2", { org: "beta", method: "admin" })).toMatchObject({ ok: false, reason: "not_org_admin" });
    expect(await proveGithubOrg(w.ports, gamma, "u2", { org: "nowhere", method: "app" })).toMatchObject({ ok: false, reason: "no_installation" });
    expect((await loadProfile(w.d1, "acme"))!.mark.text).toBe("● github.com/Acme");
    expect((await loadProfile(w.d1, "gammaorg"))!.verified_github_org).toBeNull();
    expect((await githubProofOf(w.ports, acme.id))).toMatchObject({ org: "Acme", method: "app", ends_at: null });
  });

  it("gives an organisation to one scope only", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    github(w, "u1", "ann-gh", ["acme", "other"]);
    github(w, "u2", "bob-gh", ["acme"]);
    const a = await w.org("u1", "one");
    const b = await w.org("u2", "two");
    expect(await proveGithubOrg(w.ports, a, "u1", { org: "acme", method: "admin" })).toMatchObject({ ok: true });
    expect(await proveGithubOrg(w.ports, b, "u2", { org: "acme", method: "admin" })).toMatchObject({ ok: false, reason: "taken" });
    expect(await proveGithubOrg(w.ports, a, "u1", { org: "other", method: "admin" })).toMatchObject({ ok: false, reason: "has_org" });
  });

  it("alerts at once on an uninstall, removes the proof after 7 days, and forgives a reinstall", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    github(w, "u1", "ann-gh", ["acme", "beta"]);
    github(w, "u2", "bob-gh", ["gone"]);
    install(w, 1, "acme", "ann-gh");
    install(w, 3, "beta", "ann-gh");
    const acme = await w.org("u1", "acme");
    const beta = await w.org("u1", "betaorg");
    await proveGithubOrg(w.ports, acme, "u1", { org: "acme", method: "app" });
    await proveGithubOrg(w.ports, beta, "u1", { org: "beta", method: "app" });
    const signed = await w.org("u2", "signed");
    await proveGithubOrg(w.ports, signed, "u2", { org: "gone", method: "admin" });

    expect(await sweepGithubProofs(w.ports)).toEqual({ alerted: 0, revoked: 0, restored: 0 });
    const gone = new Date(w.at() + DAY).toISOString();
    w.advance(DAY);
    w.db.exec(`update github_installations set status = 'deleted', uninstalled_at = '${gone}' where installation_id in (1, 3)`);
    expect(await sweepGithubProofs(w.ports)).toEqual({ alerted: 2, revoked: 0, restored: 0 });
    expect(await sweepGithubProofs(w.ports)).toEqual({ alerted: 0, revoked: 0, restored: 0 });
    expect(w.mail.inbox("ann@example.test").map((m) => m.subject).sort()).toEqual(["GitHub App removed from acme", "GitHub App removed from beta"]);
    expect(w.mail.inbox("ann@example.test")[0]!.text).toContain("2026-10-31");

    install(w, 33, "beta", "ann-gh");
    w.advance(7 * DAY - 1000);
    expect(await sweepGithubProofs(w.ports)).toMatchObject({ revoked: 0, restored: 1 });
    expect((await loadScope(w.d1, "acme"))!.verified_github_org).toBe("acme");
    w.advance(1000);
    expect(await sweepGithubProofs(w.ports)).toMatchObject({ revoked: 1 });
    expect((await loadScope(w.d1, "acme"))!.verified_github_org).toBeNull();
    expect((await loadScope(w.d1, "betaorg"))!.verified_github_org).toBe("beta");
    expect((await loadScope(w.d1, "signed"))!.verified_github_org).toBe("gone");
  });
});

describe("a suspended App starts the same grace (REQ-SCOPE-009)", () => {
  it("alerts, then removes the proof 7 days after the suspension", async () => {
    const w = world();
    await w.person("u1", "ann");
    w.db.exec(`insert into identities (id, user_id, provider, provider_user_id, login, created_at) values ('i1', 'u1', 'github', 'gh1', 'ann-gh', '${new Date(T0).toISOString()}')`);
    w.db.exec(`insert into github_org_admins (user_id, github_org_id, github_org_login, observed_at) values ('u1', '106', 'susp', '${new Date(T0).toISOString()}')`);
    w.db.exec(`insert into github_installations (installation_id, account_id, account_login, account_type, sender_login, repository_selection, status, installed_at, updated_at) values (7, 106, 'susp', 'Organization', 'ann-gh', 'all', 'active', '${new Date(T0).toISOString()}', '${new Date(T0).toISOString()}')`);
    const org = await w.org("u1", "suspended");
    await proveGithubOrg(w.ports, org, "u1", { org: "susp", method: "app" });
    w.advance(DAY);
    w.db.exec(`update github_installations set status = 'suspended', updated_at = '${new Date(w.at()).toISOString()}'`);
    expect(await sweepGithubProofs(w.ports)).toEqual({ alerted: 1, revoked: 0, restored: 0 });
    w.advance(7 * DAY);
    expect(await sweepGithubProofs(w.ports)).toMatchObject({ revoked: 1 });
    expect((await loadScope(w.d1, "suspended"))!.verified_github_org).toBeNull();
  });
});

describe("the grace runs from when the App stopped counting (REQ-SCOPE-009)", () => {
  it("is not extended by a later write to the installation row", async () => {
    const w = world();
    await w.person("u1", "ann");
    w.db.exec(`insert into identities (id, user_id, provider, provider_user_id, login, created_at) values ('i1', 'u1', 'github', 'gh1', 'ann-gh', '${new Date(T0).toISOString()}')`);
    w.db.exec(`insert into github_org_admins (user_id, github_org_id, github_org_login, observed_at) values ('u1', '106', 'susp', '${new Date(T0).toISOString()}')`);
    w.db.exec(`insert into github_installations (installation_id, account_id, account_login, account_type, sender_login, repository_selection, status, installed_at, updated_at) values (7, 106, 'susp', 'Organization', 'ann-gh', 'all', 'active', '${new Date(T0).toISOString()}', '${new Date(T0).toISOString()}')`);
    const org = await w.org("u1", "suspended");
    await proveGithubOrg(w.ports, org, "u1", { org: "susp", method: "app" });
    w.advance(DAY);
    const since = new Date(w.at()).toISOString();
    w.db.exec(`update github_installations set status = 'suspended', inactive_since = '${since}', updated_at = '${since}'`);
    expect(await sweepGithubProofs(w.ports)).toMatchObject({ alerted: 1 });
    w.advance(3 * DAY);
    w.db.exec(`update github_installations set status = 'deleted', uninstalled_at = '${new Date(w.at()).toISOString()}', updated_at = '${new Date(w.at()).toISOString()}'`);
    w.advance(4 * DAY);
    expect(await sweepGithubProofs(w.ports)).toMatchObject({ revoked: 1 });
  });
});

describe("Verified Publisher application (REQ-SCOPE-010, REQ-SCOPE-018)", () => {
  const policy = (w: ReturnType<typeof world>, scopeId: string, mfa: string) =>
    w.db.exec(`insert into scope_policies (scope_id, mfa, updated_at) values ('${scopeId}', '${mfa}', '${new Date(T0).toISOString()}')`);

  it("names every missing condition and asks for nothing else", async () => {
    const w = world();
    await w.person("u1", "ann");
    const bare = await w.org("u1", "bare");
    expect(await applyForVerified(w.ports, bare, "u1")).toMatchObject({ ok: false, reason: "missing_conditions", missing: ["proof", "mfa"] });
    await w.prove(bare, "bare.com");
    const noMfa = await applyForVerified(w.ports, await w.fresh("bare"), "u1");
    expect(noMfa).toMatchObject({ ok: false, missing: ["mfa"] });
    expect((noMfa as { message: string }).message).toContain("MFA scope-wide");
    const personal = (await loadScope(w.d1, "ann"))!;
    expect(await applyForVerified(w.ports, personal, "u1")).toMatchObject({ ok: false, reason: "not_org" });

    const ok = await w.org("u1", "good");
    await w.prove(ok, "good.com");
    policy(w, ok.id, "passkeys");
    const applied = await applyForVerified(w.ports, await w.fresh("good"), "u1");
    expect(applied).toMatchObject({ ok: true, application: { state: "pending", basis: "domain" } });
    expect(await applyForVerified(w.ports, await w.fresh("good"), "u1")).toMatchObject({ ok: false, reason: "pending" });
    expect(await pendingApplications(w.d1)).toMatchObject([{ scope: "good", applied_by: "ann", basis: "domain" }]);
    expect(await pendingApplicationsFor(w.d1, "u1")).toMatchObject([{ scope: "good" }]);
    expect((await verificationFacts(w.d1, ok.id))!.verified).toBe(false);
  });

  it("refuses to approve once a condition has lapsed, and suspends an approved status whose proof lapses", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("admin", "root");
    const acme = await w.org("u1", "acme");
    await w.prove(acme, "acme.com");
    policy(w, acme.id, "mfa");
    const applied = (await applyForVerified(w.ports, await w.fresh("acme"), "u1")) as { ok: true; application: { id: string } };

    w.db.exec("update scopes set verified_domain = null where name = 'acme'");
    expect(await decideApplication(w.ports, applied.application.id, "admin", { kind: "approve" })).toMatchObject({ ok: false, reason: "missing_conditions" });
    expect((await applicationOf(w.d1, acme.id)).state).toBe("pending");
    w.db.exec("update scopes set verified_domain = 'acme.com' where name = 'acme'");
    w.db.exec(`update scope_policies set mfa = 'off' where scope_id = '${acme.id}'`);
    expect(await decideApplication(w.ports, applied.application.id, "admin", { kind: "approve" })).toMatchObject({ ok: false, reason: "missing_conditions" });
    w.db.exec(`update scope_policies set mfa = 'mfa' where scope_id = '${acme.id}'`);
    expect(await decideApplication(w.ports, applied.application.id, "admin", { kind: "approve" })).toMatchObject({ ok: true });

    w.db.exec("update scopes set verified_domain = null where name = 'acme'");
    expect(await verificationFacts(w.d1, acme.id)).toMatchObject({ verified: false, verified_lapsed: true });
    w.db.exec("update scopes set verified_domain = 'acme.com' where name = 'acme'");
    expect(await verificationFacts(w.d1, acme.id)).toMatchObject({ verified: true, verified_lapsed: false });
  });

  it("explains a denial to every owner, allows renewal after 30 days, and grants and revokes", async () => {
    const w = world();
    await w.person("u1", "ann");
    await w.person("u2", "bob");
    await w.person("admin", "root");
    const acme = await w.org("u1", "acme");
    w.db.exec(`insert into scope_members (scope_id, user_id, role, created_at) values ('${acme.id}', 'u2', 'owner', '${new Date(T0).toISOString()}')`);
    await w.prove(acme, "acme.com");
    policy(w, acme.id, "mfa");
    const first = (await applyForVerified(w.ports, await w.fresh("acme"), "u1")) as { ok: true; application: { id: string } };

    expect(await decideApplication(w.ports, first.application.id, "admin", { kind: "deny", reason: "  " })).toMatchObject({ ok: false, reason: "reason_required" });
    expect(await decideApplication(w.ports, first.application.id, "admin", { kind: "deny", reason: "Domain is a redirect" })).toEqual({ ok: true, scope: "acme" });
    for (const who of ["ann", "bob"]) expect(w.mail.inbox(`${who}@example.test`).at(-1)!.text).toContain("Reason: Domain is a redirect");
    expect(await applicationOf(w.d1, acme.id)).toMatchObject({ state: "rejected", denial_reason: "Domain is a redirect" });
    expect(await pendingApplications(w.d1)).toEqual([]);
    expect(await decideApplication(w.ports, first.application.id, "admin", { kind: "approve" })).toMatchObject({ ok: false, reason: "not_pending" });

    w.advance(29 * DAY);
    const early = await applyForVerified(w.ports, await w.fresh("acme"), "u1");
    expect(early).toMatchObject({ ok: false, reason: "renew_later" });
    expect((early as { message: string }).message).toContain("2026-11-22");
    w.advance(DAY);
    const renewed = (await applyForVerified(w.ports, await w.fresh("acme"), "u1")) as { ok: true; application: { id: string; state: string } };
    expect(renewed.application.state).toBe("pending");
    expect(await decideApplication(w.ports, renewed.application.id, "admin", { kind: "approve" })).toMatchObject({ ok: true });
    expect(await verificationFacts(w.d1, acme.id)).toMatchObject({ verified: true, verified_domain: "acme.com" });
    expect((await loadProfile(w.d1, "acme"))!.mark).toMatchObject({ text: "● acme.com", hover_label: "Verified Publisher" });
    expect(await applyForVerified(w.ports, await w.fresh("acme"), "u1")).toMatchObject({ ok: false, reason: "verified" });

    expect(await revokeVerified(w.ports, acme.id, "admin", "abuse")).toMatchObject({ ok: true });
    expect(await verificationFacts(w.d1, acme.id)).toMatchObject({ verified: false, verified_domain: "acme.com" });
    expect(await revokeVerified(w.ports, acme.id, "admin", null)).toMatchObject({ ok: false });
    expect(w.reindex.messages.filter((m) => (m as { change: string }).change === "verified_publisher_changed")).toHaveLength(2);
  });
});
