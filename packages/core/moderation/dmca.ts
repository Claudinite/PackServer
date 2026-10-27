import { sendNotice } from "../mail/index.ts";
import { MAX_NOTE, DMCA_RESTORE_BUSINESS_DAYS, moderationReason } from "./constants.ts";
import { actionFor } from "./appeals.ts";
import { markRestored, recordAction } from "./actions.ts";
import { nowIso, publicUrl, type ModerationPorts } from "./ports.ts";
import { findPack, findPackById } from "./targets.ts";
import { restoreVersion, transitionVersion } from "./transition.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Weekdays elapsed after `fromMs`, up to and including the day of `toMs`; holidays are not known to the registry. */
export function businessDaysBetween(fromMs: number, toMs: number): number {
  let days = 0;
  for (let t = Date.UTC(...ymd(fromMs)) + DAY_MS; t <= Date.UTC(...ymd(toMs)); t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

function ymd(ms: number): [number, number, number] {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

export type DmcaResult = { ok: true; case_id: string; action_id: string } | { ok: false; message: string };

/**
 * Removes a version on a copyright notice. The version is held, not deleted, so a counter-notice can bring it back; the
 * publisher is told with the link where the counter-notice is filed. Nothing is sent to GitHub.
 */
export async function removeOnCopyrightNotice(ports: ModerationPorts, admin: string, input: { pack: string; version: string; complainant: string }): Promise<DmcaResult> {
  const reason = moderationReason("copyright notice");
  const moved = await transitionVersion(ports, "quarantine", { pack: input.pack, version: input.version, reason });
  if (!moved.ok) return { ok: false, message: moved.message };
  const pack = (await findPack(ports.d1, input.pack))!;
  const action = await recordAction(ports, { pack, version: input.version, kind: "dmca_removal", reason, trigger: "dmca", actor: { kind: "admin", id: admin } });
  const id = ports.rng.uuid();
  await ports.d1.query("insert into dmca_cases (id, action_id, complainant, created_at) values (?, ?, ?, ?)", [id, action.id, input.complainant, nowIso(ports)]);
  await ports.audit({ kind: "admin", id: admin }, "admin.action", `version:${pack.name}@${input.version}`, { detail: { verb: "dmca.remove" } });
  return { ok: true, case_id: id, action_id: action.id };
}

export type CounterResult = { ok: true } | { ok: false; reason: "not_found" | "not_copyright" | "already_filed" | "text_required" | "text_too_long"; message: string };

const no = (reason: Extract<CounterResult, { ok: false }>["reason"], message: string): CounterResult => ({ ok: false, reason, message });

/** The publisher's counter-notice goes to the complainant, and the clock to the version's return starts. */
export async function fileCounterNotice(ports: ModerationPorts, actionId: string, userId: string, text: string): Promise<CounterResult> {
  const action = await actionFor(ports.d1, actionId, userId);
  if (!action) return no("not_found", "There is no such action.");
  const kase = (await ports.d1.query("select id, complainant, state from dmca_cases where action_id = ?", [actionId])).rows[0];
  if (!kase) return no("not_copyright", "That action was not taken on a copyright notice.");
  const notice = text.trim();
  if (!notice) return no("text_required", "A counter-notice needs its text.");
  if (notice.length > MAX_NOTE) return no("text_too_long", `A counter-notice is at most ${MAX_NOTE} characters.`);
  const filed = await ports.d1.query(
    "update dmca_cases set state = 'counter_filed', counter_notice = ?, counter_filed_at = ?, counter_filed_by = ? where id = ? and state = 'removed'",
    [notice, nowIso(ports), userId, kase.id],
  );
  if (filed.meta.changes === 0) return no("already_filed", "A counter-notice was already filed.");
  const address = String(kase.complainant);
  await sendNotice(ports.mail, address, "dmca-counter-notice", {
    pack: action.pack,
    version: action.version,
    notice,
    restoreAfterBusinessDays: DMCA_RESTORE_BUSINESS_DAYS,
    url: publicUrl(ports, `/packs/${action.pack}`),
  });
  await ports.audit({ kind: "user", id: userId }, "admin.action", `version:${action.pack}@${action.version}`, { detail: { verb: "dmca.counter_notice" } });
  return { ok: true };
}

/** The complainant tells the registry they filed suit: the version stays out. */
export async function recordSuit(ports: ModerationPorts, caseId: string, admin: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const changed = await ports.d1.query(
    "update dmca_cases set state = 'suit_filed', suit_notified_at = ? where id = ? and state in ('removed', 'counter_filed')",
    [nowIso(ports), caseId],
  );
  if (changed.meta.changes === 0) return { ok: false, message: "No open case by that id." };
  const kase = (await ports.d1.query("select a.pack_id, a.version from dmca_cases c join moderation_actions a on a.id = c.action_id where c.id = ?", [caseId])).rows[0]!;
  const pack = (await findPackById(ports.d1, String(kase.pack_id)))!;
  await ports.audit({ kind: "admin", id: admin }, "admin.action", `version:${pack.name}@${String(kase.version)}`, { detail: { verb: "dmca.suit" } });
  return { ok: true };
}

/** Restores every version whose counter-notice has waited out the window and whose complainant has not filed suit. */
export async function sweepDmca(ports: ModerationPorts): Promise<{ restored: number }> {
  const { rows } = await ports.d1.query(
    "select c.id, c.counter_filed_at, a.id as action_id, a.pack_id, a.version from dmca_cases c join moderation_actions a on a.id = c.action_id where c.state = 'counter_filed' order by c.counter_filed_at, c.id",
  );
  let restored = 0;
  for (const row of rows) {
    if (businessDaysBetween(Date.parse(String(row.counter_filed_at)), ports.clock.now()) < DMCA_RESTORE_BUSINESS_DAYS) continue;
    const won = await ports.d1.query("update dmca_cases set state = 'restored', restored_at = ? where id = ? and state = 'counter_filed'", [nowIso(ports), row.id]);
    if (won.meta.changes === 0) continue;
    const pack = (await findPackById(ports.d1, String(row.pack_id)))!;
    const version = String(row.version);
    await restoreVersion(ports, pack.name, version);
    await markRestored(ports, pack.id, version);
    await ports.audit({ kind: "system", id: "moderation" }, "admin.action", `version:${pack.name}@${version}`, { detail: { verb: "dmca.restore" } });
    restored += 1;
  }
  return { restored };
}
