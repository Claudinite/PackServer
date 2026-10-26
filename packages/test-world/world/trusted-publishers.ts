import type { ApiResponse, Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import { callerOf } from "./areas/users";
import type { CiRepo } from "./ci-workflow";
import { InfrastructureError } from "./errors";
import { Refusal, type RefusalReason } from "./outcomes";
import type { Sensitive, User } from "./types";

const ACTION = "trusted-publisher.change";

export interface RegistrationFields {
  repo: CiRepo;
  workflow: string;
  environment?: string | null;
  path: string;
  refs?: string[];
  events?: string[];
}

export interface TrustedRegistration {
  readonly id: string;
  /** The pack as the scenario names it. */
  readonly pack: string;
  readonly repository: string;
  readonly workflow: string;
  readonly environment: string | null;
  readonly path: string;
  readonly refs: string[];
  readonly events: string[];
  /** Whether it is a pending registration reserving a name that has no pack yet. */
  readonly pending: boolean;
}

export type PublisherChangeKind = "maintainer-added" | "trusted-publisher" | "transfer-accepted" | "dormant";
export interface PublisherChangeEvent {
  readonly kind: PublisherChangeKind;
  /** Whether the validator has already applied the first-publish treatment for it. */
  readonly consumed: boolean;
}

export interface TrustedPublishersModule {
  register(pack: string, o: { by: User } & RegistrationFields & Sensitive): Promise<TrustedRegistration>;
  change(registration: TrustedRegistration, o: { by: User } & Partial<RegistrationFields> & Sensitive): Promise<TrustedRegistration>;
  list(pack: string, by: User): Promise<TrustedRegistration[]>;
  /** Turns trusted-publishing-only on or off. */
  setOnly(pack: string, on: boolean, by: User, o?: Sensitive): Promise<void>;
  /** Asks to start a web upload of the pack; a refusal is thrown. */
  webUpload(pack: string, by: User): Promise<"allowed">;
  /** The publisher-change events recorded for the pack, oldest first. */
  changes(pack: string): Promise<PublisherChangeEvent[]>;
  /** Fills the scope's pending registrations directly, as many as it takes to hold `count`, for the cap. */
  seedPending(scope: string, count: number, o: { repo: CiRepo }): Promise<void>;
}

export function createTrustedPublishers(driver: Driver, aliases: Aliases): { trusted: TrustedPublishersModule } {
  const split = (pack: string): { scope: string; name: string } => {
    const m = /^@([^/]+)\/(.+)$/.exec(pack);
    if (!m) throw new InfrastructureError(`not a pack name: ${pack}`);
    return { scope: aliases.alias(m[1]!), name: m[2]! };
  };
  const pathFor = (pack: string): string => {
    const { scope, name } = split(pack);
    return `/api/trusted-publishers/${scope}/${name}`;
  };

  function refusal(res: ApiResponse, what: string): Refusal {
    let body: { reason?: RefusalReason; message?: string };
    try {
      body = JSON.parse(aliases.unalias(res.text)) as typeof body;
    } catch {
      throw new InfrastructureError(`${what}: expected a refusal or success, got ${res.status} ${res.text.slice(0, 120)}`);
    }
    if (!body.reason) throw new InfrastructureError(`${what}: got ${res.status} without a reason: ${res.text.slice(0, 120)}`);
    return new Refusal(body.reason, body.message === undefined ? {} : { message: body.message });
  }
  const done = (res: ApiResponse, what: string): Record<string, unknown> => {
    if (res.status >= 200 && res.status < 300) return JSON.parse(aliases.unalias(res.text)) as Record<string, unknown>;
    throw refusal(res, what);
  };

  const fieldsBody = (f: Partial<RegistrationFields>) => ({
    ...(f.repo === undefined ? {} : { repository: f.repo.slug, repository_id: String(f.repo.id), repository_owner_id: String(f.repo.ownerId) }),
    ...(f.workflow === undefined ? {} : { workflow: f.workflow }),
    ...(f.environment === undefined ? {} : { environment: f.environment }),
    ...(f.path === undefined ? {} : { path: f.path }),
    ...(f.refs === undefined ? {} : { refs: f.refs }),
    ...(f.events === undefined ? {} : { events: f.events }),
  });

  const view = (pack: string, p: Record<string, unknown>): TrustedRegistration => ({
    id: String(p.id),
    pack,
    repository: String(p.repository),
    workflow: String(p.workflow),
    environment: p.environment === null ? null : String(p.environment),
    path: String(p.path),
    refs: p.refs as string[],
    events: p.events as string[],
    pending: p.pending_until !== null,
  });

  const sql = (statement: string, params: unknown[] = []) => {
    if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver has no storage seam`);
    return driver.publishStorage.sql(statement, params);
  };

  return {
    trusted: {
      async register(pack, o) {
        const { scope, name } = split(pack);
        const headers = await callerOf(o.by).assertionHeaders(ACTION, o, `${scope}/${name}`);
        const res = await callerOf(o.by).call({ method: "POST", path: pathFor(pack), json: fieldsBody(o), headers });
        return view(pack, done(res, "trusted.register").publisher as Record<string, unknown>);
      },
      async change(registration, o) {
        const { scope, name } = split(registration.pack);
        const headers = await callerOf(o.by).assertionHeaders(ACTION, o, `${scope}/${name}`);
        const res = await callerOf(o.by).call({ method: "PUT", path: `${pathFor(registration.pack)}/${registration.id}`, json: fieldsBody(o), headers });
        return view(registration.pack, done(res, "trusted.change").publisher as Record<string, unknown>);
      },
      async list(pack, by) {
        const body = done(await callerOf(by).call({ method: "GET", path: pathFor(pack) }), "trusted.list") as { publishers: Array<Record<string, unknown>> };
        return body.publishers.map((p) => view(pack, p));
      },
      async setOnly(pack, on, by, o) {
        const { scope, name } = split(pack);
        const headers = on ? {} : await callerOf(by).assertionHeaders(ACTION, o, `${scope}/${name}`);
        done(await callerOf(by).call({ method: on ? "PUT" : "DELETE", path: `${pathFor(pack)}/only`, json: {}, headers }), "trusted.setOnly");
      },
      async webUpload(pack, by) {
        done(await callerOf(by).call({ method: "POST", path: `${pathFor(pack)}/web-upload`, json: {} }), "trusted.webUpload");
        return "allowed";
      },
      async changes(pack) {
        const { scope, name } = split(pack);
        const rows = await sql("select kind, consumed_at from publisher_changes where scope_id = (select id from scopes where name = ?) and pack_name = ? order by occurred_at, id", [scope, name]);
        return rows.map((r) => ({ kind: r.kind as PublisherChangeKind, consumed: r.consumed_at !== null }));
      },
      async seedPending(scope, count, o) {
        const system = aliases.alias(scope);
        const now = new Date(driver.fakes ? await driver.fakes.clock.call<number>("now") : Date.now());
        const until = new Date(now.getTime() + 14 * 24 * 3_600_000).toISOString();
        const at = now.toISOString();
        for (let i = 0; i < count; i++) {
          await sql(
            `insert into trusted_publishers (id, scope_id, pack_name, repository_id, repository_owner_id, repository, workflow, environment, path, refs, events, pending_until, created_at, updated_at)
             select ?, s.id, ?, ?, ?, ?, '.github/workflows/publish.yml', null, ?, '["refs/heads/main"]', '["push"]', ?, ?, ? from scopes s where s.name = ?`,
            [`seed-${crypto.randomUUID()}`, `pending${i}`, String(o.repo.id), String(o.repo.ownerId), o.repo.slug, `packs/pending${i}`, until, at, at, system],
          );
        }
      },
    },
  };
}
