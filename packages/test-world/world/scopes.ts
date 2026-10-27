import type { ApiResponse, Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import { callerOf } from "./areas/users";
import { InfrastructureError } from "./errors";
import { NotFound, Refusal, type Observation, type RefusalReason } from "./outcomes";
import type { Org, Pack, Scope, Sensitive, User } from "./types";
import { applicationOf, decideApplication, loadScope, pendingApplications, revokeVerified } from "@packserver/core/scopes";
import { proofPortsOf, registryD1, systemDomain } from "./proofs";

export type ScopeRole = "owner" | "maintainer";

export interface PersonView {
  handle: string;
  role: ScopeRole;
}
export interface InvitationView {
  id: string;
  email: string | null;
  handle: string | null;
  role: ScopeRole;
}
export interface PeopleView {
  org: string;
  /** The role of the person who asked. */
  you: ScopeRole;
  people: PersonView[];
  invitations: InvitationView[];
}
export interface ProfileView {
  name: string;
  kind: "user" | "org";
  verifiedDomain: string | null;
  verifiedGithubOrg: string | null;
  verifiedPublisher: boolean;
  /** Approved once, but no proof stands now. */
  verifiedPublisherLapsed: boolean;
  /** Set while the domain proof came from a domain another scope held within the previous year. */
  verifiedDomainTransferredAt: string | null;
  held: boolean;
  /** The "disputed" notice a profile carries while a domain owner disputes the name. */
  disputed: { domain: string; since: string } | null;
  mark: { kind: "domain" | "github" | "unproven"; text: string; hoverLabel: string | null };
  packs: string[];
}

export interface Invitation {
  readonly id: string;
  readonly email?: string;
}

/** A domain being proven: where the record goes, and the hands that put it there. */
export interface DomainChallenge {
  readonly id: string;
  /** The domain as the scenario wrote it. */
  readonly domain: string;
  readonly token: string;
  /** The owner adds the TXT record the proof asks for. */
  publishTxt(): void;
  /** The owner takes every record off that name. */
  removeTxt(): void;
  /** The owner serves the token from the domain's own host. */
  serveFile(): void;
}
export type DomainCheck =
  | { status: "verified"; method: "txt" | "well-known"; transferred: boolean; movedFrom: string | null }
  | { status: "mismatch" | "missing" | "unreachable"; detail?: string };

export interface GithubProof {
  org: string;
  method: "app" | "admin";
}
export type ApplicationState = "none" | "pending" | "approved" | "rejected" | "revoked";
export interface ApplicationView {
  state: ApplicationState;
  /** The admin's reason, as the owners are shown it. */
  denialReason: string | null;
  /** A denied application may be renewed from this instant. */
  renewableAt: string | null;
  basis: "domain" | "github" | null;
}
export interface VerificationView {
  org: string;
  domain: {
    proven: { domain: string; method: "txt" | "well-known" | null; transferredAt: string | null } | null;
    pending: Array<{ domain: string; token: string }>;
  };
  github: { org: string; method: "app" | "admin"; endsAt: string | null } | null;
  application: ApplicationView;
  mfa: "none" | "mfa" | "passkey";
}

export interface OrgHandle extends Org {
  /** The name the system knows the organisation by. */
  readonly systemName: string;
  /** The same organisation, acted on by someone else. */
  as(user: User): OrgHandle;
  invite(who: User | { email: string }): { as(role: ScopeRole, o?: Sensitive): Promise<Invitation | undefined> };
  setRole(user: User, role: ScopeRole, o?: Sensitive): Promise<void>;
  remove(who: User | Invitation, o?: Sensitive): Promise<void>;
  delete(o?: Sensitive): Promise<void>;
  /** What everyone acting for the organisation must have enrolled. */
  requireMfa(policy: "none" | "mfa" | "passkey", o?: Sensitive): Promise<void>;
  people(): Promise<PeopleView | NotFound>;
  /** The people list as the site answers it, for asserting on its words. */
  peopleObservation(): Promise<Observation>;
  profile(): Promise<ProfileView | NotFound>;
  /** Starts proving a domain; nothing is proven until the record is there and `checkDomain` finds it. */
  verifyDomain(domain: string, o?: Sensitive): Promise<DomainChallenge>;
  /** "Check now". A record that is missing or wrong is a result, not a refusal. */
  checkDomain(challenge: DomainChallenge): Promise<DomainCheck>;
  /** Proves a GitHub organisation by the App installed on it (`app`) or by the person's own sign-in as its owner (`admin`). */
  verifyGitHub(org: string, via: "app" | "admin", o?: Sensitive): Promise<GithubProof>;
  /** Applies for Verified Publisher; the review that decides it is the admin's. */
  applyVerified(o?: Sensitive): Promise<ApplicationView>;
  /** As the holder of a disputed name, agrees to be renamed; the admin's decision is a separate step. */
  consentReassign(o?: Sensitive): Promise<void>;
  verification(): Promise<VerificationView | NotFound>;
  /** Gives the organisation a proof and, when asked, the Verified Publisher label, as the owners of those areas will. */
  seedProof(facts: { domain?: string; githubOrg?: string; verifiedPublisher?: boolean }): Promise<void>;
}

export interface TransferHandle {
  readonly id: string;
  readonly pack: string;
  accept(by: User, o?: Sensitive): Promise<void>;
}

export interface OrgsModule {
  create(by: User, name: string, o?: Sensitive): Promise<OrgHandle>;
  get(name: string, by?: User): OrgHandle;
}
export interface TransfersModule {
  offer(pack: Pack, o: { to: Org | Scope; by: User } & Sensitive): Promise<TransferHandle>;
  /** The same, for a caller who may not know the pack exists: `NotFound` is a result, not a failure. */
  tryOffer(pack: Pack, o: { to: Org | Scope; by: User } & Sensitive): Promise<TransferHandle | NotFound>;
  /** Where the pack's old id answers it went, or `NotFound` for a pack that never moved. */
  movedTo(pack: Pack): Promise<string | NotFound>;
  incoming(user: User): Promise<Array<{ id: string; pack: string; from: string; to: string; state: string }>>;
}
export interface ScopeViewsModule {
  profile(scope: Scope | Org): Promise<ProfileView | NotFound>;
}
export interface InvitationsModule {
  pending(user: User): Promise<Array<{ id: string; scope: string; role: ScopeRole }>>;
  accept(user: User, invitation: Invitation): Promise<void>;
}

export interface ReviewModule {
  /** The Verified Publisher items waiting in the admin's review queue. */
  queue(): Promise<Array<{ scope: string; appliedBy: string; basis: "domain" | "github" | null }>>;
  approve(org: Org): Promise<void>;
  deny(org: Org, reason: string): Promise<void>;
  revoke(org: Org, reason?: string): Promise<void>;
  /** The organisations of this person whose application is waiting: the "Needs you" item. */
  needsYou(user: User): Promise<string[]>;
  /** What the registry told the reindex queue about this scope, oldest first. */
  reindexed(org: Org | Scope): Promise<string[]>;
}

export interface ScopeVerbs {
  verifiedPublishers: ReviewModule;
  orgs: OrgsModule;
  transfers: TransfersModule;
  invitations: InvitationsModule;
  profiles: ScopeViewsModule;
}

interface ApplicationWire {
  state: ApplicationState;
  denial_reason: string | null;
  renewable_at: string | null;
  basis: "domain" | "github" | null;
}
const applicationView = (a: ApplicationWire): ApplicationView => ({ state: a.state, denialReason: a.denial_reason, renewableAt: a.renewable_at, basis: a.basis });

/** Every sensitive verb makes its own assertion; the negatives replace or remove it. */
const assertionHeaders = (by: User, action: string, target: string, o?: Sensitive): Promise<Record<string, string>> => callerOf(by).assertionHeaders(action, o, target);

export function createScopeVerbs(driver: Driver, aliases: Aliases): ScopeVerbs {
  const parse = (res: ApiResponse): Record<string, unknown> => JSON.parse(aliases.unalias(res.text)) as Record<string, unknown>;

  /** A refusal is the site's JSON body; anything else from a verb that should have worked is a broken harness. */
  function refusal(res: ApiResponse, what: string): Refusal {
    let body: { reason?: RefusalReason; message?: string };
    try {
      body = parse(res) as typeof body;
    } catch {
      throw new InfrastructureError(`${what}: expected a refusal or success, got ${res.status} ${res.text.slice(0, 120)}`);
    }
    if (!body.reason) throw new InfrastructureError(`${what}: got ${res.status} without a reason: ${res.text.slice(0, 120)}`);
    return new Refusal(body.reason, body.message === undefined ? {} : { message: aliases.unalias(body.message) });
  }

  /** A command that succeeds answers with a body; a refusal is thrown, and a missing resource is a harness error. */
  function done(res: ApiResponse, what: string): Record<string, unknown> {
    if (res.status >= 200 && res.status < 300) return parse(res);
    if (res.status === 404) throw new InfrastructureError(`${what}: the site answered "not found"`);
    throw refusal(res, what);
  }

  const get = (path: string): Promise<ApiResponse> => driver.http.request({ surface: "web", method: "GET", path, headers: { "cf-connecting-ip": "198.51.100.77" } });

  const profileOf = async (name: string): Promise<ProfileView | NotFound> => {
    const res = await get(`/api/scopes/${aliases.alias(name)}`);
    if (res.status === 404) return new NotFound();
    if (res.status !== 200) throw new InfrastructureError(`profile ${name}: ${res.status} ${res.text.slice(0, 120)}`);
    const b = parse(res) as {
      name: string; kind: "user" | "org"; verified_domain: string | null; verified_github_org: string | null; verified_publisher: boolean; verified_publisher_lapsed: boolean;
      verified_domain_transferred_at: string | null; held: boolean; disputed: { domain: string; since: string } | null;
      mark: { kind: "domain" | "github" | "unproven"; text: string; hover_label: string | null }; packs: string[];
    };
    return {
      name: b.name,
      kind: b.kind,
      verifiedDomain: b.verified_domain,
      verifiedGithubOrg: b.verified_github_org,
      verifiedPublisher: b.verified_publisher,
      verifiedPublisherLapsed: b.verified_publisher_lapsed,
      verifiedDomainTransferredAt: b.verified_domain_transferred_at,
      held: b.held,
      disputed: b.disputed,
      mark: { kind: b.mark.kind, text: b.mark.text, hoverLabel: b.mark.hover_label },
      packs: b.packs,
    };
  };

  function org(name: string, acting: User | undefined): OrgHandle {
    const system = aliases.alias(name);
    const as = (): User => {
      if (!acting) throw new InfrastructureError(`org ${name}: say who acts on it with .as(user)`);
      return acting;
    };
    const call = async (method: string, path: string, action: string | null, o?: Sensitive, json?: unknown, target = system) => {
      const headers = action ? await assertionHeaders(as(), action, target, o) : {};
      return callerOf(as()).call({ method, path: `/api/orgs/${system}${path}`, ...(json === undefined ? {} : { json }), headers });
    };
    const self: OrgHandle = {
      name,
      systemName: system,
      as: (user) => org(name, user),
      invite(who) {
        return {
          as: async (role, o) => {
            const target = "handle" in who ? { handle: aliases.alias(who.handle) } : who;
            const body = done(await call("POST", "/people", "org.invite", o, { ...target, role }), "org.invite");
            if (body.outcome !== "invited") return undefined;
            const view = (await self.people()) as PeopleView;
            const email = "email" in target ? target.email : undefined;
            const found = view.invitations.find((i) => (email ? i.email === email.toLowerCase() : i.handle === (who as User).handle));
            if (!found) throw new InfrastructureError("org.invite: the invitation is not listed");
            return email ? { id: found.id, email } : { id: found.id };
          },
        };
      },
      async setRole(user, role, o) {
        done(await call("POST", `/people/${aliases.alias(user.handle)}/role`, "org.set-role", o, { role }, `${system}/${aliases.alias(user.handle)}`), "org.setRole");
      },
      async remove(who, o) {
        const path = "handle" in who ? `/people/${aliases.alias(who.handle)}` : `/invitations/${who.id}`;
        const bound = "handle" in who ? `${system}/${aliases.alias(who.handle)}` : `${system}/invitations/${who.id}`;
        done(await call("DELETE", path, "org.remove", o, undefined, bound), "org.remove");
      },
      async delete(o) {
        done(await call("DELETE", "", "org.delete", o), "org.delete");
      },
      async requireMfa(policy, o) {
        done(await call("POST", "/mfa-policy", "org.mfa-policy", o, { policy }), "org.requireMfa");
      },
      async people() {
        const res = await call("GET", "/people", null);
        if (res.status === 404) return new NotFound();
        const b = done(res, "org.people") as { org: string; you: ScopeRole; people: Array<{ handle: string; role: ScopeRole }>; invitations: InvitationView[] };
        return { org: b.org, you: b.you, people: b.people.map((p) => ({ handle: p.handle, role: p.role })).sort((x, y) => (x.handle < y.handle ? -1 : 1)), invitations: b.invitations };
      },
      async peopleObservation() {
        const res = await call("GET", "/people", null);
        return { status: res.status, headers: {}, body: aliases.unalias(res.text) };
      },
      profile: () => profileOf(name),
      async verifyDomain(domain, o) {
        const sys = systemDomain(aliases, domain);
        const body = done(await call("POST", "/verification/domain", "org.prove-domain", o, { domain: sys }, `${system}/${sys}`), "org.verifyDomain") as {
          challenge: { id: string; token: string; txt: { name: string; value: string }; wellKnown: { url: string } };
        };
        const c = body.challenge;
        // The response was read back in the scenario's words; the record goes where the system looks for it.
        const txtName = `_packserver-challenge.${sys}`;
        const domains = () => {
          if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fake DNS`);
          return driver.fakes.domains;
        };
        return {
          id: c.id,
          domain,
          token: c.token,
          publishTxt: () => domains().publishTxt(txtName, c.txt.value),
          removeTxt: () => domains().removeTxt(txtName),
          serveFile: () => domains().serve(sys, { kind: "file", body: `${c.token}\n` }),
        };
      },
      async checkDomain(challenge) {
        const body = done(await callerOf(as()).call({ method: "POST", path: `/api/orgs/${system}/verification/domain/${challenge.id}/check`, json: {} }), "org.checkDomain") as {
          result: { status: string; method?: "txt" | "well-known"; transferred?: boolean; movedFrom?: string | null; detail?: string };
        };
        const r = body.result;
        if (r.status === "verified") {
          return { status: "verified", method: r.method!, transferred: r.transferred === true, movedFrom: r.movedFrom ? aliases.unalias(r.movedFrom) : null };
        }
        return { status: r.status as "mismatch" | "missing" | "unreachable", ...(r.detail ? { detail: r.detail } : {}) };
      },
      async verifyGitHub(githubOrg, via, o) {
        const body = done(await call("POST", "/verification/github", "org.prove-github", o, { org: githubOrg, method: via }, `${system}/${githubOrg.toLowerCase()}`), "org.verifyGitHub") as {
          github: GithubProof;
        };
        return body.github;
      },
      async applyVerified(o) {
        const body = done(await call("POST", "/application", "org.apply-verified", o), "org.applyVerified") as { application: ApplicationWire };
        return applicationView(body.application);
      },
      async consentReassign(o) {
        done(await call("POST", "/dispute/consent", "org.consent-reassign", o), "org.consentReassign");
      },
      async verification() {
        const res = await call("GET", "/verification", null);
        if (res.status === 404) return new NotFound();
        const b = done(res, "org.verification") as {
          org: string;
          domain: { proven: { domain: string; method: "txt" | "well-known" | null; transferred_at: string | null } | null; pending: Array<{ domain: string; token: string }> };
          github: { org: string; method: "app" | "admin"; ends_at: string | null } | null;
          application: ApplicationWire;
          mfa: "none" | "mfa" | "passkey";
        };
        return {
          org: b.org,
          domain: {
            proven: b.domain.proven ? { domain: aliases.unalias(b.domain.proven.domain), method: b.domain.proven.method, transferredAt: b.domain.proven.transferred_at } : null,
            pending: b.domain.pending.map((p) => ({ domain: aliases.unalias(p.domain), token: p.token })),
          },
          github: b.github ? { org: b.github.org, method: b.github.method, endsAt: b.github.ends_at } : null,
          application: applicationView(b.application),
          mfa: b.mfa,
        };
      },
      async seedProof(facts) {
        const store = await driver.storage?.();
        if (!store) throw new InfrastructureError(`the ${driver.kind} driver has no storage seam`);
        const now = new Date(driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now()).toISOString();
        const statements = [
          store.db.prepare("update scopes set verified_domain = ?, verified_github_org = ? where name = ?").bind(facts.domain ?? null, facts.githubOrg ?? null, system),
        ];
        if (facts.verifiedPublisher) {
          statements.push(
            store.db
              .prepare(
                "insert into vp_applications (id, scope_id, state, applied_by, applied_at, decided_at) select ?, s.id, 'approved', m.user_id, ?, ? from scopes s join scope_members m on m.scope_id = s.id and m.role = 'owner' where s.name = ? limit 1",
              )
              .bind(crypto.randomUUID(), now, now, system),
          );
        }
        await store.db.batch(statements);
      },
    };
    return self;
  }

  const splitPack = (pack: Pack): { scope: string; name: string } => {
    const m = /^@([^/]+)\/(.+)$/.exec(pack.systemName);
    if (!m) throw new InfrastructureError(`not a pack name: ${pack.systemName}`);
    return { scope: m[1] as string, name: m[2] as string };
  };

  const adminId = async (): Promise<string> => {
    const d1 = await registryD1(driver);
    const now = new Date(driver.fakes ? await driver.fakes.clock.call("now") : Date.now()).toISOString();
    await d1.query("insert or ignore into users (id, handle, created_at) values ('world-admin', 'world-admin', ?)", [now]);
    return "world-admin";
  };
  const applicationIdOf = async (name: string): Promise<{ id: string; scopeId: string }> => {
    const d1 = await registryD1(driver);
    const scope = await loadScope(d1, aliases.alias(name));
    const app = scope ? await applicationOf(d1, scope.id) : null;
    if (!scope || !app?.id) throw new InfrastructureError(`${name} has no application to decide`);
    return { id: app.id, scopeId: scope.id };
  };
  const failed = (what: string, result: { ok: boolean; message?: string }): void => {
    if (!result.ok) throw new InfrastructureError(`${what}: ${result.message}`);
  };
  const verifiedPublishers: ReviewModule = {
    async queue() {
      const d1 = await registryD1(driver);
      return (await pendingApplications(d1)).map((a) => ({ scope: aliases.unalias(a.scope), appliedBy: aliases.unalias(a.applied_by), basis: a.basis }));
    },
    async approve(target) {
      const { id } = await applicationIdOf(target.name);
      const decided = await decideApplication(await proofPortsOf(driver), id, await adminId(), { kind: "approve" });
      if (!decided.ok && decided.reason === "missing_conditions") throw new Refusal("forbidden", { message: aliases.unalias(decided.message) });
      failed("review.approve", decided);
    },
    async deny(target, reason) {
      const { id } = await applicationIdOf(target.name);
      failed("review.deny", await decideApplication(await proofPortsOf(driver), id, await adminId(), { kind: "deny", reason }));
    },
    async revoke(target, reason) {
      const { scopeId } = await applicationIdOf(target.name);
      failed("review.revoke", await revokeVerified(await proofPortsOf(driver), scopeId, await adminId(), reason ?? null));
    },
    async needsYou(user) {
      const body = done(await callerOf(user).call({ method: "GET", path: "/api/me/verification" }), "review.needsYou") as { pending: Array<{ scope: string }> };
      return body.pending.map((p) => aliases.unalias(p.scope));
    },
    async reindexed(target) {
      const system = aliases.alias(target.name);
      const found: string[] = [];
      const take = (message: unknown): void => {
        if (Array.isArray(message)) return message.forEach(take);
        const m = message as { type?: unknown; scope?: unknown; change?: unknown } | null;
        if (m && typeof m === "object") {
          if (m.type === "scope.proof_changed" && m.scope === system) found.push(String(m.change));
          else Object.values(m).forEach((v) => typeof v === "object" && take(v));
        }
      };
      driver.fakes?.ports.queues["REINDEX_QUEUE"]?.messages.forEach(take);
      return found;
    },
  };

  return {
    verifiedPublishers,
    orgs: {
      async create(by, name, o) {
        const headers = await assertionHeaders(by, "org.create", aliases.alias(name), o);
        const res = await callerOf(by).call({ method: "POST", path: "/api/orgs", json: { name: aliases.alias(name) }, headers });
        done(res, "org.create");
        return org(name, by);
      },
      get: (name, by) => org(name, by),
    },
    profiles: { profile: (scope) => profileOf(scope.name) },
    invitations: {
      async pending(user) {
        const body = done(await callerOf(user).call({ method: "GET", path: "/api/invitations" }), "invitations.pending") as { invitations: Array<{ id: string; scope: string; role: ScopeRole }> };
        return body.invitations;
      },
      async accept(user, invitation) {
        done(await callerOf(user).call({ method: "POST", path: `/api/invitations/${invitation.id}/accept`, json: {} }), "invitations.accept");
      },
    },
    transfers: {
      async offer(pack, o) {
        const out = await this.tryOffer(pack, o);
        if (out instanceof NotFound) throw new InfrastructureError(`pack.transfer: ${pack.name} was not found`);
        return out;
      },
      async tryOffer(pack, o) {
        const { scope, name } = splitPack(pack);
        const headers = await assertionHeaders(o.by, "pack.transfer", `${scope}/${name}`, o);
        const res = await callerOf(o.by).call({
          method: "POST",
          path: `/api/scopes/${scope}/packs/${name}/transfer`,
          json: { to: aliases.alias(o.to.name) },
          headers,
        });
        if (res.status === 404) return new NotFound();
        const body = done(res, "pack.transfer") as { transfer: { id: string } };
        return {
          id: body.transfer.id,
          pack: pack.systemName,
          accept: async (by, accept) => {
            const headers = await assertionHeaders(by, "pack.transfer.accept", body.transfer.id, accept);
            done(await callerOf(by).call({ method: "POST", path: `/api/transfers/${body.transfer.id}/accept`, json: {}, headers }), "pack.transfer.accept");
          },
        };
      },
      async movedTo(pack) {
        const { scope, name } = splitPack(pack);
        const res = await get(`/api/scopes/${scope}/moved/${name}`);
        if (res.status === 404) return new NotFound();
        return (parse(res) as { moved_to: string }).moved_to;
      },
      async incoming(user) {
        const body = done(await callerOf(user).call({ method: "GET", path: "/api/transfers" }), "transfers.incoming") as { transfers: Array<{ id: string; pack: string; from: string; to: string; state: string }> };
        return body.transfers;
      },
    },
  };
}
