import type { ApiResponse, Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import { callerOf } from "./areas/users";
import { InfrastructureError } from "./errors";
import { NotFound, Refusal, type Observation, type RefusalReason } from "./outcomes";
import type { Org, Pack, Scope, Sensitive, User } from "./types";

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
  mark: { kind: "domain" | "github" | "unproven"; text: string; hoverLabel: string | null };
  packs: string[];
}

export interface Invitation {
  readonly id: string;
  readonly email?: string;
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
  people(): Promise<PeopleView | NotFound>;
  /** The people list as the site answers it, for asserting on its words. */
  peopleObservation(): Promise<Observation>;
  profile(): Promise<ProfileView | NotFound>;
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

export interface ScopeVerbs {
  orgs: OrgsModule;
  transfers: TransfersModule;
  invitations: InvitationsModule;
  profiles: ScopeViewsModule;
}

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
      name: string; kind: "user" | "org"; verified_domain: string | null; verified_github_org: string | null; verified_publisher: boolean;
      mark: { kind: "domain" | "github" | "unproven"; text: string; hover_label: string | null }; packs: string[];
    };
    return {
      name: b.name,
      kind: b.kind,
      verifiedDomain: b.verified_domain,
      verifiedGithubOrg: b.verified_github_org,
      verifiedPublisher: b.verified_publisher,
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

  return {
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
