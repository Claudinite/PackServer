import { z } from "zod";
import { ABUSE_CATEGORIES, ABUSE_TARGET_KINDS } from "@packserver/schema/db";
import { WIDELY_DECLARED, isHighSeverity, MAX_DETAILS, STANDING_REPORTERS } from "./constants.ts";
import { declaredBy } from "./declared.ts";
import { recordAction } from "./actions.ts";
import { nowIso, type ModerationPorts } from "./ports.ts";
import { prioritisedAttrs } from "./signals.ts";
import { standingOf } from "./standing.ts";
import { findPackById, findPublicPack, hasVersion, newestVersion, type PackInfo } from "./targets.ts";
import { transitionVersion } from "./transition.ts";

export const AbuseInput = z.object({
  kind: z.enum(ABUSE_TARGET_KINDS),
  /** A pack's `@scope/name`, a review's id or a scope's name. */
  target: z.string().min(1).max(200),
  version: z.string().min(1).max(64).optional(),
  category: z.enum(ABUSE_CATEGORIES),
  details: z.string().trim().min(1).max(MAX_DETAILS),
});
export type AbuseInput = z.infer<typeof AbuseInput>;

export interface AbuseReportView {
  id: string;
  kind: AbuseInput["kind"];
  target: string;
  category: AbuseInput["category"];
  /** The report repeats one already filed on the target and counts as no independent report. */
  collapsed: boolean;
  prioritised: boolean;
}

export type FileOutcome =
  | { ok: true; report: AbuseReportView }
  | { ok: false; reason: "unknown_target" | "unknown_version" | "blocked" | "duplicate"; message: string };

const refuse = (reason: Extract<FileOutcome, { ok: false }>["reason"], message: string): FileOutcome => ({ ok: false, reason, message });

async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Identical means the same category and the same words, whatever the case or spacing. */
const detailsKey = (category: string, details: string): Promise<string> => sha256(`${category}\n${details.toLowerCase().replace(/\s+/g, " ").trim()}`);

interface Resolved {
  target_id: string;
  pack: PackInfo | null;
  version: string | null;
  label: string;
}

async function resolve(ports: Pick<ModerationPorts, "d1">, input: AbuseInput): Promise<Resolved | FileOutcome> {
  const { d1 } = ports;
  if (input.kind === "pack") {
    const pack = await findPublicPack(d1, input.target);
    if (!pack) return refuse("unknown_target", "There is no such pack.");
    const version = input.version ?? (await newestVersion(d1, pack.id));
    if (version === null || !(await hasVersion(d1, pack.id, version))) return refuse("unknown_version", "That version does not exist.");
    return { target_id: pack.id, pack, version, label: pack.name };
  }
  if (input.kind === "review") {
    const review = (await d1.query("select pack_id from reviews where id = ? and hidden_at is null", [input.target])).rows[0];
    const pack = review ? await findPackById(d1, String(review.pack_id)) : null;
    if (!pack) return refuse("unknown_target", "There is no such review.");
    return { target_id: input.target, pack, version: null, label: "a review" };
  }
  const scope = (await d1.query("select id from scopes where name = ?", [input.target.replace(/^@/, "")])).rows[0];
  if (!scope) return refuse("unknown_target", "There is no such profile.");
  return { target_id: String(scope.id), pack: null, version: null, label: "a profile" };
}

/**
 * Files an abuse report (REQ-MOD-008). A high-severity report on a pack labels it and starts the judge's hour; the
 * version is held at once only when the reporter has standing and the hold is allowed (REQ-MOD-009).
 */
export async function fileAbuseReport(ports: ModerationPorts, reporterId: string, input: AbuseInput): Promise<FileOutcome> {
  const { d1 } = ports;
  if ((await d1.query("select 1 from abuse_reporter_blocks where reporter_id = ?", [reporterId])).rows.length > 0) {
    return refuse("blocked", "You can no longer file reports.");
  }
  const found = await resolve(ports, input);
  if ("ok" in found) return found;
  const key = await detailsKey(input.category, input.details);
  const same = (await d1.query("select id, reporter_id, collapsed_into from abuse_reports where target_kind = ? and target_id = ? and details_key = ? and state = 'open' order by created_at, id", [input.kind, found.target_id, key])).rows;
  if (same.some((r) => r.reporter_id === reporterId)) return refuse("duplicate", "You already reported this.");
  const head = same.find((r) => r.collapsed_into === null);
  const id = ports.rng.uuid();
  const at = nowIso(ports);
  const prioritised = head === undefined && found.pack !== null && found.version !== null && isHighSeverity(input.category);
  await d1.query(
    `insert into abuse_reports (id, target_kind, target_id, pack_id, version, reporter_id, category, details, details_key, prioritised_at, collapsed_into, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.kind, found.target_id, found.pack?.id ?? null, found.version, reporterId, input.category, input.details, key, prioritised ? at : null, head ? String(head.id) : null, at],
  );
  ports.emit("moderation.report_received", { report: id, category: input.category, target: input.kind, collapsed: head !== undefined, ...(found.pack ? { pack: found.pack.name } : {}) });
  const view: AbuseReportView = { id, kind: input.kind, target: found.label, category: input.category, collapsed: head !== undefined, prioritised };
  if (prioritised && found.pack && found.version) {
    const declared = await declaredBy(d1, found.pack.name);
    ports.emit("moderation.report_prioritised", prioritisedAttrs({ id, pack: found.pack.name, version: found.version, declaredBy: declared }));
    const grounds = await holdGrounds(ports, reporterId, found.pack, found.version, declared);
    if (grounds) await holdOnStanding(ports, found.pack, found.version, grounds);
  }
  return { ok: true, report: view };
}

type Grounds = "verified_publisher" | "reporters";

/** Which standing, if any, holds the version now: never when the declaring count is unknown or above 100. */
async function holdGrounds(ports: ModerationPorts, reporterId: string, pack: PackInfo, version: string, declared: number | null): Promise<Grounds | null> {
  if (declared === null || declared > WIDELY_DECLARED) return null;
  const now = ports.clock.now();
  if ((await standingOf(ports.d1, reporterId, pack, now)) === "verified_publisher") return "verified_publisher";
  const { rows } = await ports.d1.query(
    "select distinct reporter_id from abuse_reports where pack_id = ? and version = ? and target_kind = 'pack' and state = 'open' and collapsed_into is null and prioritised_at is not null",
    [pack.id, version],
  );
  let counted = 0;
  for (const row of rows) if ((await standingOf(ports.d1, String(row.reporter_id), pack, now)) === "established") counted += 1;
  return counted >= STANDING_REPORTERS ? "reporters" : null;
}

const GROUNDS: Record<Grounds, string> = {
  verified_publisher: "Reported by a Verified Publisher and held for review",
  reporters: "Reported by several established accounts and held for review",
};

async function holdOnStanding(ports: ModerationPorts, pack: PackInfo, version: string, grounds: Grounds): Promise<void> {
  const reason = GROUNDS[grounds];
  const moved = await transitionVersion(ports, "quarantine", { pack: pack.name, version, reason });
  if (!moved.ok || !moved.changed) return;
  const actor = { kind: "system" as const, id: "moderation" };
  await recordAction(ports, { pack, version, kind: "quarantine", reason, trigger: "report_standing", actor });
  await ports.audit(actor, "admin.action", `version:${pack.name}@${version}`, { detail: { verb: "version.quarantine", reason } });
}
