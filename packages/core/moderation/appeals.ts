import type { D1 } from "@packserver/ports";
import { roleOf } from "../scopes/access.ts";
import { satisfies } from "../scopes/roles.ts";
import { MAX_NOTE } from "./constants.ts";
import { markRestored } from "./actions.ts";
import { notifyOwners } from "./notify.ts";
import { nowIso, publicUrl, type ModerationPorts } from "./ports.ts";
import { findPackById } from "./targets.ts";
import { restoreVersion } from "./transition.ts";

export interface ActionView {
  id: string;
  pack: string;
  version: string;
  kind: string;
  reason: string;
  taken_at: string;
  restored: boolean;
  appeal: { state: "open" | "upheld" | "denied"; note: string } | null;
  /** A copyright removal is answered with a counter-notice, not an appeal. */
  counter_notice: boolean;
}

/** An action as its publisher reads it; anyone else gets nothing. */
export async function actionFor(d1: D1, actionId: string, userId: string): Promise<ActionView | null> {
  const a = (await d1.query("select * from moderation_actions where id = ?", [actionId])).rows[0];
  const pack = a ? await findPackById(d1, String(a.pack_id)) : null;
  if (!a || !pack || !satisfies(await roleOf(d1, pack.scope_id, userId), "maintainer")) return null;
  const appeal = (await d1.query("select state, note from moderation_appeals where action_id = ?", [actionId])).rows[0];
  return {
    id: String(a.id),
    pack: pack.name,
    version: String(a.version),
    kind: String(a.kind),
    reason: String(a.reason),
    taken_at: String(a.taken_at),
    restored: a.restored_at !== null,
    appeal: appeal ? { state: appeal.state as "open" | "upheld" | "denied", note: String(appeal.note) } : null,
    counter_notice: a.kind === "dmca_removal",
  };
}

export type AppealOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_appealed" | "already_restored" | "counter_notice" | "note_required" | "note_too_long"; message: string };

const no = (reason: Extract<AppealOutcome, { ok: false }>["reason"], message: string): AppealOutcome => ({ ok: false, reason, message });

/** One appeal per action, from someone who maintains the pack; once decided it cannot be filed again (REQ-MOD-014). */
export async function fileAppeal(ports: Pick<ModerationPorts, "d1" | "clock">, actionId: string, userId: string, note: string): Promise<AppealOutcome> {
  const action = await actionFor(ports.d1, actionId, userId);
  if (!action) return no("not_found", "There is no such action.");
  const text = note.trim();
  if (!text) return no("note_required", "Say why the action should be undone.");
  if (text.length > MAX_NOTE) return no("note_too_long", `An appeal is at most ${MAX_NOTE} characters.`);
  if (action.counter_notice) return no("counter_notice", "A copyright removal is answered with a counter-notice.");
  if (action.restored) return no("already_restored", "The action was already undone.");
  if (action.appeal) return no("already_appealed", action.appeal.state === "open" ? "The appeal is already with a moderator." : "The decision on the appeal is final.");
  await ports.d1.query("insert into moderation_appeals (action_id, note, submitted_by, submitted_at) values (?, ?, ?, ?)", [actionId, text, userId, nowIso(ports)]);
  return { ok: true };
}

export interface OpenAppeal {
  action_id: string;
  pack: string;
  version: string;
  action: string;
  reason: string;
  note: string;
  submitted_at: string;
}

export async function openModerationAppeals(d1: D1): Promise<OpenAppeal[]> {
  const { rows } = await d1.query(
    `select a.action_id, a.note, a.submitted_at, m.version, m.kind, m.reason, '@' || s.name || '/' || p.name as pack
     from moderation_appeals a join moderation_actions m on m.id = a.action_id join packs p on p.id = m.pack_id join scopes s on s.id = p.scope_id
     where a.state = 'open' order by a.submitted_at, a.action_id`,
  );
  return rows.map((r) => ({ action_id: String(r.action_id), pack: String(r.pack), version: String(r.version), action: String(r.kind), reason: String(r.reason), note: String(r.note), submitted_at: String(r.submitted_at) }));
}

export type DecideResult = { ok: true; pack: string; version: string } | { ok: false; reason: "unknown" | "not_open" };

/** Upholding restores the version; a denial is final and logged. */
export async function decideModerationAppeal(ports: ModerationPorts, actionId: string, admin: string, outcome: "upheld" | "denied"): Promise<DecideResult> {
  const row = (await ports.d1.query("select a.state, m.pack_id, m.version from moderation_appeals a join moderation_actions m on m.id = a.action_id where a.action_id = ?", [actionId])).rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  const changed = await ports.d1.query("update moderation_appeals set state = ?, decided_by = ?, decided_at = ? where action_id = ? and state = 'open'", [outcome, admin, nowIso(ports), actionId]);
  if (changed.meta.changes === 0) return { ok: false, reason: "not_open" };
  const pack = (await findPackById(ports.d1, String(row.pack_id)))!;
  const version = String(row.version);
  if (outcome === "upheld") {
    await restoreVersion(ports, pack.name, version);
    await markRestored(ports, pack.id, version);
  }
  await ports.audit({ kind: "admin", id: admin }, "admin.action", `version:${pack.name}@${version}`, { detail: { verb: `moderation.appeal.${outcome}` } });
  await notifyOwners(ports, pack.scope_id, "appeal-decided", { pack: `${pack.name}@${version}`, outcome, packUrl: publicUrl(ports, `/packs/${pack.name}`) });
  return { ok: true, pack: pack.name, version };
}
