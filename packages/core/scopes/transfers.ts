import type { D1 } from "@packserver/ports";
import { toHex } from "../identity/sessions.ts";
import { loadScope, roleOf } from "./access.ts";
import type { ScopePorts } from "./personal.ts";

/** An offer stands for seven days. */
export const TRANSFER_WINDOW_MS = 7 * 24 * 3_600_000;

export interface Transfer {
  id: string;
  pack: string;
  from: string;
  to: string;
  offered_at: string;
  expires_at: string;
  state: "offered" | "accepted" | "lapsed";
}

export type OfferResult =
  | { ok: true; transfer: Transfer }
  | { ok: false; reason: "unknown_target" | "same_scope" | "already_offered" | "name_taken"; message: string };

const fromRow = (r: Record<string, unknown>): Transfer => ({
  id: String(r.id),
  pack: `@${String(r.from_scope)}/${String(r.pack_name)}`,
  from: String(r.from_scope),
  to: String(r.to_scope),
  offered_at: String(r.offered_at),
  expires_at: String(r.expires_at),
  state: r.state as Transfer["state"],
});

const COLUMNS = "id, pack_name, from_scope, to_scope, offered_at, expires_at, state";

/** Records the offer; the pack stays where it is until the receiving scope's owner accepts. */
export async function offerTransfer(
  ports: ScopePorts,
  input: { packId: string; packName: string; fromScope: string; toScope: string; offeredBy: string },
): Promise<OfferResult> {
  const target = await loadScope(ports.d1, input.toScope);
  if (!target) return { ok: false, reason: "unknown_target", message: "No such scope to offer the pack to." };
  if (target.name === input.fromScope) return { ok: false, reason: "same_scope", message: "The pack is already in that scope." };
  const clash = await ports.d1.query("select 1 as hit from packs where scope_id = ? and name = ?", [target.id, input.packName]);
  if (clash.rows.length > 0) return { ok: false, reason: "name_taken", message: `${target.name} already has a pack called ${input.packName}.` };
  const now = ports.clock.now();
  await expireOffers(ports.d1, now);
  const open = await ports.d1.query("select 1 as hit from pack_transfers where pack_id = ? and state = 'offered'", [input.packId]);
  if (open.rows.length > 0) return { ok: false, reason: "already_offered", message: "This pack already has an open offer." };
  const id = toHex(ports.rng.bytes(16));
  await ports.d1.query(
    `insert into pack_transfers (id, pack_id, pack_name, from_scope, to_scope, offered_by, offered_at, expires_at, state)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'offered')`,
    [id, input.packId, input.packName, input.fromScope, target.name, input.offeredBy, new Date(now).toISOString(), new Date(now + TRANSFER_WINDOW_MS).toISOString()],
  );
  const { rows } = await ports.d1.query(`select ${COLUMNS} from pack_transfers where id = ?`, [id]);
  return { ok: true, transfer: fromRow(rows[0]!) };
}

/** An offer past its window is lapsed for good; this is applied whenever offers are read or answered. */
export async function expireOffers(d1: D1, nowMs: number): Promise<void> {
  await d1.query("update pack_transfers set state = 'lapsed', resolved_at = ? where state = 'offered' and expires_at <= ?", [
    new Date(nowMs).toISOString(),
    new Date(nowMs).toISOString(),
  ]);
}

export async function loadTransfer(d1: D1, id: string): Promise<Transfer | null> {
  const { rows } = await d1.query(`select ${COLUMNS} from pack_transfers where id = ?`, [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Offers waiting on scopes this person owns. */
export async function incomingFor(ports: ScopePorts, userId: string): Promise<Transfer[]> {
  await expireOffers(ports.d1, ports.clock.now());
  const { rows } = await ports.d1.query(
    `select t.${COLUMNS.replaceAll(", ", ", t.")} from pack_transfers t join scopes s on s.name = t.to_scope
     join scope_members m on m.scope_id = s.id and m.user_id = ? and m.role = 'owner'
     where t.state = 'offered' order by t.offered_at`,
    [userId],
  );
  return rows.map(fromRow);
}

export type AcceptResult =
  | { ok: true; transfer: Transfer }
  | { ok: false; reason: "not_found" | "forbidden" | "lapsed" | "settled" | "name_taken" | "moved_on"; message: string };

/** Only an owner of the receiving scope completes a transfer, and only while the offer stands. */
export async function acceptTransfer(ports: ScopePorts, userId: string, id: string): Promise<AcceptResult> {
  await expireOffers(ports.d1, ports.clock.now());
  const transfer = await loadTransfer(ports.d1, id);
  if (!transfer) return { ok: false, reason: "not_found", message: "No such offer." };
  const target = await loadScope(ports.d1, transfer.to);
  if (!target || (await roleOf(ports.d1, target.id, userId)) !== "owner") {
    return target ? { ok: false, reason: "forbidden", message: "Only an owner of the receiving scope accepts an offer." } : { ok: false, reason: "not_found", message: "No such offer." };
  }
  if (transfer.state === "lapsed") return { ok: false, reason: "lapsed", message: "This offer lapsed after 7 days; ask for a new one." };
  if (transfer.state !== "offered") return { ok: false, reason: "settled", message: "This offer was already answered." };
  const now = new Date(ports.clock.now()).toISOString();
  const source = await loadScope(ports.d1, transfer.from);
  const pack = await ports.d1.query("select id, scope_id from packs where id = (select pack_id from pack_transfers where id = ?)", [id]);
  if (!source || pack.rows[0]?.scope_id !== source.id) return { ok: false, reason: "moved_on", message: "The pack is no longer in the offering scope." };
  try {
    await ports.d1.batch([
      { sql: "update packs set scope_id = ? where id = ? and scope_id = ?", params: [target.id, pack.rows[0]!.id, source.id] },
      { sql: "update pack_transfers set state = 'accepted', resolved_by = ?, resolved_at = ? where id = ?", params: [userId, now, id] },
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) return { ok: false, reason: "name_taken", message: `${target.name} already has a pack called ${transfer.pack.split("/")[1]}.` };
    throw error;
  }
  return { ok: true, transfer: { ...transfer, state: "accepted" } };
}

/** Where `@scope/name` went, following successive transfers, or null when it never moved. */
export async function movedTo(d1: D1, scope: string, packName: string): Promise<string | null> {
  let at = { scope, name: packName };
  let moved = false;
  for (let hop = 0; hop < 8; hop++) {
    const { rows } = await d1.query(
      "select to_scope from pack_transfers where state = 'accepted' and from_scope = ? and pack_name = ? order by resolved_at desc limit 1",
      [at.scope, at.name],
    );
    const next = rows[0]?.to_scope;
    if (typeof next !== "string") break;
    at = { scope: next, name: at.name };
    moved = true;
  }
  return moved ? `@${at.scope}/${at.name}` : null;
}
