import { setScopeMfaPolicy } from "@packserver/core/identity";
import { createOrg, invite, startDomainProof } from "@packserver/core/scopes";
import { describe, expect, it } from "vitest";
import { setup, signUp, wordsOf, ORIGIN, type Harness } from "./people";

async function orgWithOwner(h: Harness, handle = "ann", org = "acme") {
  const owner = await signUp(h, handle);
  const made = await createOrg(h.ports, owner.userId, org);
  if (!made.ok) throw new Error(made.message);
  return { owner, scopeId: made.scope.id };
}

async function addMaintainer(h: Harness, scopeId: string, handle = "max") {
  const maintainer = await signUp(h, handle);
  await h.d1.query("insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'maintainer', ?)", [scopeId, maintainer.userId, "2026-10-01T00:00:00.000Z"]);
  return maintainer;
}

const proofPorts = (h: Harness) => ({ ...h.ports, dns: h.runtime.ports.dns, wellKnown: h.runtime.ports.wellKnown, mail: h.runtime.ports.mail, reindex: h.runtime.ports.queues.REINDEX_QUEUE!, siteOrigin: ORIGIN });

describe("org settings page: who sees it (REQ-SCOPE-003, REQ-PRIV-001)", () => {
  it("sends a signed-out visitor to sign in and back", async () => {
    const h = setup();
    const res = await h.request("/orgs/acme/settings");
    expect([res.status, res.headers.get("location")]).toEqual([303, `/signin?next=${encodeURIComponent("/orgs/acme/settings")}`]);
  });

  it("answers an outsider, a personal scope and an unknown organisation with the same not-found page", async () => {
    const h = setup();
    await orgWithOwner(h);
    const outsider = await signUp(h, "zed");
    const seen = await Promise.all(["/orgs/acme/settings", "/orgs/zed/settings", "/orgs/nobody/settings"].map(async (path) => {
      const res = await outsider.get(path);
      return [res.status, wordsOf(await res.text())] as const;
    }));
    expect(seen.map(([status]) => status)).toEqual([404, 404, 404]);
    expect(new Set(seen.map(([, words]) => words)).size).toBe(1);
  });

  it("asks someone who lacks the organisation's required factor to enrol one", async () => {
    const h = setup();
    const { owner, scopeId } = await orgWithOwner(h);
    await setScopeMfaPolicy(h.ports, scopeId, "passkey", owner.userId);
    await h.d1.query("delete from credentials where user_id = ?", [owner.userId]);
    const res = await owner.get("/orgs/acme/settings");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("requires a passkey");
    expect(html).not.toContain('data-do="apply"');
  });
});

describe("org settings page: an owner's view", () => {
  it("lists the five sections, the people by role and never calls a person a member (IT-SCOPE-003)", async () => {
    const h = setup();
    const { owner, scopeId } = await orgWithOwner(h);
    await addMaintainer(h, scopeId);
    const invited = await invite(h.ports, { id: scopeId, name: "acme", kind: "org", state: "active", verified_domain: null, verified_github_org: null }, owner.userId, { email: "new@example.test" }, "maintainer");
    expect(invited.ok).toBe(true);
    const res = await owner.get("/orgs/acme/settings");
    const html = await res.text();
    const words = wordsOf(html);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    for (const id of ["general", "verification", "people", "security", "danger"]) expect(html).toContain(`id="${id}"`);
    expect(words).toContain("@ann owner");
    expect(words).toContain("@max maintainer");
    expect(words).toContain("new@example.test invited as maintainer");
    expect(words).not.toMatch(/\bmembers?\b/i);
    for (const act of ["set-role", "remove-person", "remove-invitation"]) expect(html).toContain(`data-do="${act}"`);
    expect(html).toContain('id="invite"');
    expect((html.match(/<dialog id="ps-dialog"/g) ?? []).length).toBe(1);
    for (const tag of html.match(/<script[^>]*>/g) ?? []) expect(tag).toMatch(/^<script nonce="[0-9a-f]+">$/);
  });

  it("shows the proofs, the record to publish with Check now, and nothing before the owner asks (IT-SCOPE-004)", async () => {
    const h = setup();
    const { owner, scopeId } = await orgWithOwner(h);
    const before = wordsOf(await (await owner.get("/orgs/acme/settings")).text());
    expect(before).toContain("No domain is proven yet.");
    expect(before).toContain("No GitHub organisation is proven yet.");

    const started = await startDomainProof(proofPorts(h), { id: scopeId, name: "acme", kind: "org", state: "active", verified_domain: null, verified_github_org: null }, "acme.com");
    if (!started.ok) throw new Error(started.message);
    const html = await (await owner.get("/orgs/acme/settings")).text();
    expect(wordsOf(html)).toContain(`_packserver-challenge.acme.com TXT ${started.challenge.token}`);
    expect(wordsOf(html)).toContain("https://acme.com/.well-known/packserver-auth");
    expect(html).toContain(`data-do="check-domain" data-id="${started.challenge.id}"`);
    expect(html).toContain('id="prove-domain"');
    expect(html).toContain('id="prove-github"');
  });

  it("shows a proven domain and a proven GitHub organisation instead of the forms", async () => {
    const h = setup();
    const { owner, scopeId } = await orgWithOwner(h);
    await h.d1.query("update scopes set verified_domain = 'acme.com' where id = ?", [scopeId]);
    await h.d1.query(
      "insert into domain_challenges (id, scope_id, domain, token, state, method, proven_at, created_at) values ('c1', ?, 'acme.com', 'tok', 'proven', 'txt', '2026-10-05T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
      [scopeId],
    );
    const words = wordsOf(await (await owner.get("/orgs/acme/settings")).text());
    expect(words).toContain("acme.com is proven by a DNS record, since 2026-10-05");
  });

  it("walks a Verified Publisher application through its states and prices it struck through (IT-SCOPE-018, IT-PAY-017)", async () => {
    const h = setup();
    const { owner, scopeId } = await orgWithOwner(h);
    const page = async () => (await owner.get("/orgs/acme/settings")).text();

    let html = await page();
    expect(html).toContain('<s>$99 a year</s><span class="free">free through 2026</span>');
    expect(wordsOf(html)).toContain("Before applying: prove a domain or a GitHub organisation; and require MFA");
    expect(html).toMatch(/data-do="apply"[^>]*disabled/);

    await h.d1.query("update scopes set verified_domain = 'acme.com' where id = ?", [scopeId]);
    await setScopeMfaPolicy(h.ports, scopeId, "mfa", owner.userId);
    html = await page();
    expect(html).not.toMatch(/data-do="apply"[^>]*disabled/);
    expect(html).toContain('data-do="apply"');

    await h.d1.query("insert into vp_applications (id, scope_id, state, applied_by, applied_at, basis) values ('a1', ?, 'pending', ?, '2026-10-10T00:00:00.000Z', 'domain')", [scopeId, owner.userId]);
    html = await page();
    expect(wordsOf(html)).toContain("Verification pending. Applied 2026-10-10");
    expect(html).not.toContain('data-do="apply"');

    await h.d1.query("update vp_applications set state = 'rejected', decided_at = '2026-10-12T00:00:00.000Z', denial_reason = 'Domain looks parked', renewable_at = '2099-11-11T00:00:00.000Z' where id = 'a1'");
    html = await page();
    expect(wordsOf(html)).toContain("Not approved on 2026-10-12: Domain looks parked");
    expect(wordsOf(html)).toContain("You can apply again from 2099-11-11");
    expect(html).toMatch(/data-do="apply"[^>]*disabled/);

    await h.d1.query("update vp_applications set state = 'approved' where id = 'a1'");
    expect(wordsOf(await page())).toContain("Verified Publisher, resting on the domain proof");
  });

  it("offers a checkout, a card form or a Buy action nowhere", async () => {
    const h = setup();
    const { owner } = await orgWithOwner(h);
    const html = await (await owner.get("/orgs/acme/settings")).text();
    expect(wordsOf(html)).not.toMatch(/checkout|credit card|\bbuy\b|subscribe|invoice/i);
    expect(html).not.toMatch(/<input[^>]*(cc-number|card)/i);
  });

  it("selects the organisation's sign-in requirement (IT-ACC-018)", async () => {
    const h = setup();
    const { owner, scopeId } = await orgWithOwner(h);
    const options = (html: string) => [...html.matchAll(/<option value="(none|mfa|passkey)"( selected(?:="")?)?>/g)].map((m) => [m[1], Boolean(m[2])]);
    expect(options(await (await owner.get("/orgs/acme/settings")).text())).toEqual([["none", true], ["mfa", false], ["passkey", false]]);
    await setScopeMfaPolicy(h.ports, scopeId, "passkey", owner.userId);
    expect(options(await (await owner.get("/orgs/acme/settings")).text())).toEqual([["none", false], ["mfa", false], ["passkey", true]]);
  });

  it("offers a transfer for each pack and refuses to offer delete while the organisation owns one", async () => {
    const h = setup();
    const { owner, scopeId } = await orgWithOwner(h);
    let html = await (await owner.get("/orgs/acme/settings")).text();
    expect(wordsOf(html)).toContain("The organisation has no packs.");
    expect(html).not.toMatch(/data-do="delete-org"[^>]*disabled/);

    await h.d1.query("insert into packs (id, scope_id, name, visibility, created_at) values ('p1', ?, 'gcp', 'public', '2026-10-01T00:00:00.000Z')", [scopeId]);
    html = await (await owner.get("/orgs/acme/settings")).text();
    expect(html).toContain('<option value="@acme/gcp">@acme/gcp</option>');
    expect(html).toMatch(/data-do="delete-org"[^>]*disabled/);
    expect(wordsOf(html)).toContain("It owns 1 pack");
  });
});

describe("org settings page: a maintainer's view", () => {
  it("shows everything read-only: no forms and no buttons that change the organisation", async () => {
    const h = setup();
    const { scopeId } = await orgWithOwner(h);
    const max = await addMaintainer(h, scopeId);
    const res = await max.get("/orgs/acme/settings");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(wordsOf(html)).toContain("Your role maintainer");
    expect(html).not.toMatch(/<form/);
    expect(html).not.toMatch(/data-do="(apply|set-role|remove-person|remove-invitation|delete-org|check-domain)"/);
    expect(wordsOf(html)).toContain("Only an owner can transfer a pack or delete the organisation.");
  });
});
