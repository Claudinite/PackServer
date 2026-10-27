import { describe, expect, it } from "vitest";
import { FakeDns, FakeMail, FakeQueue, FakeWellKnown } from "@packserver/ports/fakes";
import { migratedD1 } from "../../identity/testing.ts";
import {
  checkDomainProof, clearScopeHold, createOrg, loadProfile, loadScope, openDisputes, personalScopeStatements, recordHolderConsent, resolveDispute, startDomainProof,
  type ProofPorts, type ScopeRow,
} from "../index.ts";

const T0 = Date.parse("2026-10-23T00:00:00.000Z");

function world() {
  const { d1, db } = migratedD1();
  let n = 0;
  const dns = new FakeDns();
  const mail = new FakeMail();
  const reindex = new FakeQueue();
  const ports: ProofPorts = {
    d1,
    clock: { now: () => T0 },
    rng: { float: () => 0.5, uuid: () => crypto.randomUUID(), bytes: (len) => Uint8Array.from({ length: len }, () => ++n & 255) },
    dns, wellKnown: new FakeWellKnown(), mail, reindex,
    siteOrigin: "https://registry.test",
  };
  const at = new Date(T0).toISOString();
  const person = async (id: string, handle: string) => {
    db.exec(`insert into users (id, handle, created_at) values ('${id}', '${handle}', '${at}')`);
    await d1.batch(personalScopeStatements(ports, id, handle));
    db.exec(`insert into user_emails (user_id, address, source, created_at) values ('${id}', '${handle}@example.test', 'github', '${at}')`);
  };
  const org = async (userId: string, name: string): Promise<ScopeRow> => {
    const made = await createOrg(ports, userId, name);
    if (!made.ok) throw new Error(made.message);
    return made.scope;
  };
  const prove = async (scope: ScopeRow, domain: string) => {
    const started = await startDomainProof(ports, scope, domain);
    if (!started.ok) throw new Error(started.message);
    dns.txt.set(started.challenge.txt.name, [started.challenge.txt.value]);
    await checkDomainProof(ports, (await loadScope(d1, scope.name))!, started.challenge.id);
  };
  const publish = (scope: ScopeRow) => {
    db.exec(`insert into packs (id, scope_id, name, visibility, created_at) values ('p-${scope.id}', '${scope.id}', 'gcp', 'public', '${at}')`);
    db.exec(`insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values ('v-${scope.id}', 'p-${scope.id}', '1.0.0', 'active', '${"0".repeat(64)}', 1, '${at}', 0, 0)`);
  };
  return { ports, d1, db, mail, reindex, person, org, prove, publish };
}

/** `@acme` is held by one person and its domain proved by another, who owns `@rightful`. */
async function disputed(w: ReturnType<typeof world>, o: { publishing?: boolean } = {}) {
  await w.person("u-s", "s");
  await w.person("u-r", "r");
  const holder = await w.org("u-s", "acme");
  const claimant = await w.org("u-r", "rightful");
  if (o.publishing) w.publish(holder);
  await w.prove(claimant, "acme.com");
  const [dispute] = await openDisputes(w.d1);
  return { holder, claimant, dispute: dispute! };
}

describe("resolving a dispute (REQ-ADMIN-005, REQ-SCOPE-011)", () => {
  it("lists the open dispute with what decides it", async () => {
    const w = world();
    const { dispute } = await disputed(w);
    expect(dispute).toMatchObject({ scope: "acme", claimant: "rightful", domain: "acme.com", held: true, promoted: false, consented: false, noticeAttached: false });
  });

  it("moves the name of a scope with no promoted version, renames and tells the holder, and re-signs both", async () => {
    const w = world();
    const { holder, claimant, dispute } = await disputed(w);
    const outcome = await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "reassign" });
    expect(outcome).toEqual({ ok: true, scope: "acme", renamedTo: "acme-prior" });

    expect((await loadScope(w.d1, "acme"))!.id).toBe(claimant.id);
    const renamed = (await loadScope(w.d1, "acme-prior"))!;
    expect(renamed).toMatchObject({ id: holder.id, state: "active" });
    expect(await loadScope(w.d1, "rightful")).toBeNull();
    expect((await w.d1.query("select 1 as hit from retired_names where kind = 'scope' and name = 'rightful'")).rows).toHaveLength(1);
    expect((await w.d1.query("select state, resolution, resolved_by from scope_disputes")).rows[0]).toEqual({ state: "resolved", resolution: "reassigned", resolved_by: "admin@example.test" });
    expect((await loadProfile(w.d1, "acme"))).toMatchObject({ verified_domain: "acme.com" });

    const notice = w.mail.sent.find((m) => m.subject.includes("is now"));
    expect(notice?.to).toBe("s@example.test");
    expect(notice?.text).toContain("@acme-prior");
    const told = w.reindex.messages.slice(-2).map((m) => (m as { scope: string }).scope).sort();
    expect(told).toEqual(["acme", "acme-prior"]);
  });

  it("refuses to move a scope with a promoted public version until its holder consents", async () => {
    const w = world();
    const { holder, dispute } = await disputed(w, { publishing: true });
    expect(dispute).toMatchObject({ held: false, promoted: true });
    expect(await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "reassign" })).toMatchObject({ ok: false, reason: "has_promoted_versions" });
    expect((await loadScope(w.d1, "acme"))!.id).toBe(holder.id);

    expect(await recordHolderConsent(w.ports, holder.id, "u-s")).toEqual({ ok: true, disputes: 1 });
    expect((await openDisputes(w.d1))[0]).toMatchObject({ consented: true });
    expect(await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "reassign", holderName: "acme-old" })).toEqual({ ok: true, scope: "acme", renamedTo: "acme-old" });
    expect((await w.d1.query("select count(*) as n from packs where scope_id = ?", [holder.id])).rows[0]!.n).toBe(1);
    expect((await loadScope(w.d1, "acme-old"))!.id).toBe(holder.id);
  });

  it("takes a consent only for a scope in dispute", async () => {
    const w = world();
    await w.person("u-s", "s");
    const lone = await w.org("u-s", "lone");
    expect(await recordHolderConsent(w.ports, lone.id, "u-s")).toEqual({ ok: false, reason: "no_dispute" });
  });

  it("keeps the name with its holder and ends the hold", async () => {
    const w = world();
    const { holder, dispute } = await disputed(w);
    expect((await loadScope(w.d1, "acme"))!.state).toBe("held");
    expect(await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "keep" })).toEqual({ ok: true, scope: "acme" });
    expect(await loadScope(w.d1, "acme")).toMatchObject({ id: holder.id, state: "active" });
    expect(await openDisputes(w.d1)).toEqual([]);
  });

  it("attaches the notice without moving the name, and leaves the dispute open", async () => {
    const w = world();
    const { dispute } = await disputed(w, { publishing: true });
    expect(await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "notice" })).toEqual({ ok: true, scope: "acme" });
    expect((await openDisputes(w.d1))[0]).toMatchObject({ noticeAttached: true });
    expect((await loadScope(w.d1, "acme"))!.state).toBe("active");
  });

  it("decides a dispute once", async () => {
    const w = world();
    const { dispute } = await disputed(w);
    await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "keep" });
    expect(await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "reassign" })).toMatchObject({ ok: false, reason: "not_open" });
    expect(await resolveDispute(w.ports, "nope", "admin@example.test", { kind: "keep" })).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("asks for another name when the one chosen is taken", async () => {
    const w = world();
    const { dispute } = await disputed(w);
    expect(await resolveDispute(w.ports, dispute.id, "admin@example.test", { kind: "reassign", holderName: "s" })).toMatchObject({ ok: false, reason: "name_unavailable" });
    expect((await loadScope(w.d1, "acme"))!.state).toBe("held");
  });
});

describe("clearing the hold on a handle (REQ-ADMIN-007)", () => {
  it("lets a held handle publish again", async () => {
    const w = world();
    await w.person("u-h", "acmee");
    w.db.exec("update scopes set state = 'held' where name = 'acmee'");
    expect(await clearScopeHold(w.ports, "acmee")).toEqual({ ok: true, scope: "acmee" });
    expect((await loadScope(w.d1, "acmee"))!.state).toBe("active");
    expect(await clearScopeHold(w.ports, "acmee")).toMatchObject({ ok: false, reason: "not_held" });
    expect(await clearScopeHold(w.ports, "ghost")).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("leaves a hold an open dispute set to the dispute", async () => {
    const w = world();
    await disputed(w);
    expect(await clearScopeHold(w.ports, "acme")).toMatchObject({ ok: false, reason: "open_dispute" });
  });
});
