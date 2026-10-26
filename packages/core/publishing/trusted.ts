import type { Clock, D1, Rng } from "@packserver/ports";
import { iso, newId } from "../scopes/personal.ts";
import { DEFAULT_EVENTS, defaultRefs } from "./oidc.ts";

/** REQ-PUB-001: how long a registration for a pack that does not exist yet reserves its name. */
export const PENDING_NAME_MS = 14 * 24 * 3_600_000;
/** REQ-PUB-001: pending registrations a scope may hold at once. */
export const PENDING_CAP = 10;

export interface TrustedPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

/** What a caller names; the ids are GitHub's immutable ones, the slug is for display. */
export interface PublisherInput {
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  workflow: string;
  environment?: string | null;
  path: string;
  refs?: string[];
  events?: string[];
  default_branch?: string;
}

export interface PublisherView {
  id: string;
  pack: string;
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  workflow: string;
  environment: string | null;
  path: string;
  refs: string[];
  events: string[];
  /** Set while the pack does not exist: the instant the reservation lapses. */
  pending_until: string | null;
  created_at: string;
  updated_at: string;
}

type Scope = { id: string; name: string };

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGITS = /^[0-9]{1,20}$/;
const CLEAN_PATH = (value: string): boolean => value.length > 0 && value.length <= 300 && !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "") && !/[\p{Cc}@]/u.test(value);
const ALLOWED_EVENTS = new Set<string>(DEFAULT_EVENTS);

/** The input made canonical, or the first thing wrong with it. */
export function normalizePublisher(input: PublisherInput, packName: string): { ok: true; value: Required<Omit<PublisherInput, "default_branch">> } | { ok: false; message: string } {
  if (!SLUG.test(input.repository)) return { ok: false, message: "repository: use owner/name." };
  if (!DIGITS.test(input.repository_id) || !DIGITS.test(input.repository_owner_id)) return { ok: false, message: "repository_id and repository_owner_id: use GitHub's numeric ids." };
  if (!CLEAN_PATH(input.workflow)) return { ok: false, message: "workflow: use the workflow file's path inside the repository." };
  if (!CLEAN_PATH(input.path)) return { ok: false, message: "path: use the pack's folder inside the repository." };
  const environment = input.environment ?? null;
  if (environment !== null && (environment.length === 0 || environment.length > 100 || /\p{Cc}/u.test(environment))) return { ok: false, message: "environment: name a GitHub environment or leave it out." };
  const refs = input.refs ?? defaultRefs(packName, input.default_branch ?? "main");
  if (refs.length === 0 || refs.length > 10 || !refs.every((r) => typeof r === "string" && /^refs\/[^\s]{1,200}$/.test(r))) return { ok: false, message: "refs: give up to 10 patterns, each starting with refs/." };
  const events = input.events ?? [...DEFAULT_EVENTS];
  if (events.length === 0 || events.length > 10 || !events.every((e) => typeof e === "string" && ALLOWED_EVENTS.has(e))) {
    return { ok: false, message: `events: choose from ${DEFAULT_EVENTS.join(", ")}; events an outsider can trigger are refused.` };
  }
  return { ok: true, value: { repository: input.repository, repository_id: input.repository_id, repository_owner_id: input.repository_owner_id, workflow: input.workflow, environment, path: input.path, refs: [...new Set(refs)], events: [...new Set(events)] } };
}

const COLUMNS = "id, pack_name, repository, repository_id, repository_owner_id, workflow, environment, path, refs, events, pending_until, created_at, updated_at";

const toView = (row: Record<string, unknown>): PublisherView => ({
  id: String(row.id),
  pack: String(row.pack_name),
  repository: String(row.repository),
  repository_id: String(row.repository_id),
  repository_owner_id: String(row.repository_owner_id),
  workflow: String(row.workflow),
  environment: row.environment === null ? null : String(row.environment),
  path: String(row.path),
  refs: JSON.parse(String(row.refs)) as string[],
  events: JSON.parse(String(row.events)) as string[],
  pending_until: row.pending_until === null ? null : String(row.pending_until),
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
});

/** Registrations of one pack that still count: a pending one past its 14 days is gone. */
export async function listPublishers(ports: Pick<TrustedPorts, "d1" | "clock">, scopeId: string, packName: string): Promise<PublisherView[]> {
  const { rows } = await ports.d1.query(
    `select ${COLUMNS} from trusted_publishers where scope_id = ? and pack_name = ? and (pending_until is null or pending_until > ?) order by created_at, id`,
    [scopeId, packName, iso(ports)],
  );
  return rows.map(toView);
}

const CAP_MESSAGE = `A scope holds at most ${PENDING_CAP} pending registrations; wait for one to lapse or publish a pack.`;

export type RegisterRefusal = { ok: false; reason: "invalid" | "cap" | "exists" | "not-found"; message: string };

const eventStatement = (ports: TrustedPorts, scopeId: string, packName: string, userId: string, guard: { id: string }) => ({
  sql: `insert into publisher_changes (id, scope_id, pack_name, kind, occurred_at, caused_by)
        select ?, ?, ?, 'trusted-publisher', ?, ? where exists (select 1 from trusted_publishers where id = ?)`,
  params: [newId(ports), scopeId, packName, iso(ports), userId, guard.id],
});

/**
 * Adds a trusted publisher to a pack and emits the publisher-change event the validator reads
 * (REQ-VAL-038). A pack that does not exist yet gets a pending registration, which reserves the
 * name for 14 days and counts against the scope's cap of 10.
 */
export async function registerPublisher(
  ports: TrustedPorts,
  request: { scope: Scope; packName: string; userId: string; input: PublisherInput; beforeWrite?: () => Promise<void> },
): Promise<{ ok: true; publisher: PublisherView } | RegisterRefusal> {
  const { scope, packName, userId } = request;
  const normal = normalizePublisher(request.input, packName);
  if (!normal.ok) return { ok: false, reason: "invalid", message: normal.message };
  const v = normal.value;
  const now = iso(ports);

  const { rows: packRows } = await ports.d1.query("select 1 from packs where scope_id = ? and name = ?", [scope.id, packName]);
  const pending = packRows.length === 0;
  await ports.d1.query(
    `delete from trusted_publishers where scope_id = ? and pending_until is not null and pending_until <= ?
       and not exists (select 1 from packs p where p.scope_id = trusted_publishers.scope_id and p.name = trusted_publishers.pack_name)`,
    [scope.id, now],
  );

  const { rows: same } = await ports.d1.query(
    "select 1 from trusted_publishers where scope_id = ? and pack_name = ? and repository_id = ? and workflow = ? and coalesce(environment, '') = ? and path = ?",
    [scope.id, packName, v.repository_id, v.workflow, v.environment ?? "", v.path],
  );
  if (same.length > 0) return { ok: false, reason: "exists", message: "That repository, workflow, environment and path are already registered for this pack." };

  if (pending) {
    const { rows: held } = await ports.d1.query("select count(*) as n from trusted_publishers where scope_id = ? and pending_until is not null and pending_until > ?", [scope.id, now]);
    if (Number(held[0]?.n) >= PENDING_CAP) return { ok: false, reason: "cap", message: CAP_MESSAGE };
  }
  await request.beforeWrite?.();

  const id = newId(ports);
  const pendingUntil = pending ? new Date(ports.clock.now() + PENDING_NAME_MS).toISOString() : null;
  const [inserted] = await ports.d1.batch([
    {
      sql: `insert into trusted_publishers (id, scope_id, pack_name, repository_id, repository_owner_id, repository, workflow, environment, path, refs, events, pending_until, created_by, created_at, updated_at)
            select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            where ? = 0 or (select count(*) from trusted_publishers where scope_id = ? and pending_until is not null and pending_until > ?) < ?`,
      params: [
        id, scope.id, packName, v.repository_id, v.repository_owner_id, v.repository, v.workflow, v.environment, v.path, JSON.stringify(v.refs), JSON.stringify(v.events),
        pendingUntil, userId, now, now, pending ? 1 : 0, scope.id, now, PENDING_CAP,
      ],
    },
    eventStatement(ports, scope.id, packName, userId, { id }),
  ]);
  if (inserted!.meta.changes === 0) return { ok: false, reason: "cap", message: CAP_MESSAGE };
  const { rows } = await ports.d1.query(`select ${COLUMNS} from trusted_publishers where id = ?`, [id]);
  return { ok: true, publisher: toView(rows[0]!) };
}

/** Changes one registration of the pack, and emits the publisher-change event. */
export async function changePublisher(
  ports: TrustedPorts,
  request: { scope: Scope; packName: string; userId: string; id: string; patch: Partial<PublisherInput>; beforeWrite?: () => Promise<void> },
): Promise<{ ok: true; before: PublisherView; publisher: PublisherView } | RegisterRefusal> {
  const { scope, packName, userId } = request;
  const found = (await listPublishers(ports, scope.id, packName)).find((p) => p.id === request.id);
  if (!found) return { ok: false, reason: "not-found", message: "No such trusted publisher on this pack." };
  const merged: PublisherInput = {
    repository: found.repository, repository_id: found.repository_id, repository_owner_id: found.repository_owner_id, workflow: found.workflow,
    environment: found.environment, path: found.path, refs: found.refs, events: found.events,
    ...request.patch,
  };
  const normal = normalizePublisher(merged, packName);
  if (!normal.ok) return { ok: false, reason: "invalid", message: normal.message };
  const v = normal.value;
  const now = iso(ports);
  await request.beforeWrite?.();
  await ports.d1.batch([
    {
      sql: `update trusted_publishers set repository = ?, repository_id = ?, repository_owner_id = ?, workflow = ?, environment = ?, path = ?, refs = ?, events = ?, updated_at = ? where id = ?`,
      params: [v.repository, v.repository_id, v.repository_owner_id, v.workflow, v.environment, v.path, JSON.stringify(v.refs), JSON.stringify(v.events), now, found.id],
    },
    eventStatement(ports, scope.id, packName, userId, found),
  ]);
  const { rows } = await ports.d1.query(`select ${COLUMNS} from trusted_publishers where id = ?`, [found.id]);
  return { ok: true, before: found, publisher: toView(rows[0]!) };
}

/** A promoted version ends the reservation: the pack exists now, so its registrations stop lapsing. */
export async function settlePending(d1: D1, scopeId: string, packName: string): Promise<void> {
  await d1.query("update trusted_publishers set pending_until = null where scope_id = ? and pack_name = ? and pending_until is not null", [scopeId, packName]);
}

export async function setTrustedOnly(ports: Pick<TrustedPorts, "d1" | "clock">, scopeId: string, packName: string, on: boolean, beforeWrite?: () => Promise<void>): Promise<boolean> {
  const { rows } = await ports.d1.query("select 1 from packs where scope_id = ? and name = ?", [scopeId, packName]);
  if (rows.length === 0) return false;
  await beforeWrite?.();
  await ports.d1.query(
    `insert into pack_publish_settings (scope_id, pack_name, trusted_only, updated_at) values (?, ?, ?, ?)
     on conflict (scope_id, pack_name) do update set trusted_only = excluded.trusted_only, updated_at = excluded.updated_at`,
    [scopeId, packName, on ? 1 : 0, iso(ports)],
  );
  return true;
}

export type WebUploadGate = { ok: true } | { ok: false; reason: "trusted-only" | "reserved"; message: string };

/** REQ-PUB-008 and REQ-PUB-001: whether a web upload may start for this pack name. */
export async function webUploadGate(ports: Pick<TrustedPorts, "d1" | "clock">, scopeId: string, packName: string): Promise<WebUploadGate> {
  const { rows: settings } = await ports.d1.query("select 1 from pack_publish_settings where scope_id = ? and pack_name = ? and trusted_only = 1", [scopeId, packName]);
  if (settings.length > 0) return { ok: false, reason: "trusted-only", message: "This pack accepts uploads only from its trusted publisher." };
  const { rows } = await ports.d1.query("select 1 from packs where scope_id = ? and name = ?", [scopeId, packName]);
  if (rows.length === 0) {
    const pending = await ports.d1.query("select 1 from trusted_publishers where scope_id = ? and pack_name = ? and pending_until is not null and pending_until > ? limit 1", [scopeId, packName, iso(ports)]);
    if (pending.rows.length > 0) return { ok: false, reason: "reserved", message: "This name is reserved for a pending trusted publisher." };
  }
  return { ok: true };
}

/** Whether the pack's next version is owed the first-publish review because of an unconsumed publisher-change event. */
export async function hasPublisherChange(d1: D1, scopeId: string, packName: string): Promise<boolean> {
  const { rows } = await d1.query("select 1 from publisher_changes where scope_id = ? and pack_name = ? and consumed_at is null limit 1", [scopeId, packName]);
  return rows.length > 0;
}

/** Every verified address of the scope's owners, one per address. */
export async function ownerAddresses(d1: D1, scopeId: string): Promise<string[]> {
  const { rows } = await d1.query(
    `select distinct e.address from scope_members m join user_emails e on e.user_id = m.user_id where m.scope_id = ? and m.role = 'owner' order by e.address`,
    [scopeId],
  );
  return rows.map((r) => String(r.address));
}
