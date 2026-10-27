import { sendNotice, type NoticeData, type NoticeKind } from "../../mail/index.ts";
import type { Dns, Mail, Queue, WellKnown } from "@packserver/ports";
import type { D1 } from "@packserver/ports";
import type { ScopePorts } from "../personal.ts";

/** Everything a proof needs from outside the database; each is a port, so tests fake them. */
export interface ProofPorts extends ScopePorts {
  dns: Dns;
  wellKnown: WellKnown;
  mail: Mail;
  /** The `reindex` queue: a change to what a scope has proven re-signs its index. */
  reindex: Queue;
  /** The public origin notices link to; always https. */
  siteOrigin: string;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RECHECK_INTERVAL_MS = 30 * DAY_MS;
export const LAPSE_AFTER_MS = 30 * DAY_MS;
export const GITHUB_UNINSTALL_GRACE_MS = 7 * DAY_MS;
export const TRANSFER_MEMORY_MS = 365 * DAY_MS;
export const RENEWAL_WAIT_MS = 30 * DAY_MS;

export const isoOf = (ms: number): string => new Date(ms).toISOString();
export const dateOf = (ms: number): string => isoOf(ms).slice(0, 10);

/** What a reindex consumer receives; `change` says why, and a consumer that does not care re-signs anyway. */
export interface ScopeProofChanged {
  schema: 1;
  type: "scope.proof_changed";
  scope: string;
  change: "domain_verified" | "domain_moved" | "domain_lapsed" | "github_verified" | "github_revoked" | "verified_publisher_changed" | "visibility_changed";
}

export async function announceProofChange(ports: ProofPorts, scope: string, change: ScopeProofChanged["change"]): Promise<void> {
  const message: ScopeProofChanged = { schema: 1, type: "scope.proof_changed", scope, change };
  await ports.reindex.send(message);
}

export const settingsUrl = (ports: Pick<ProofPorts, "siteOrigin">, scope: string): string =>
  `https://${new URL(ports.siteOrigin).host}/orgs/${scope}/settings`;

/** Every verified address of the scope's owners. */
export async function ownerAddresses(d1: D1, scopeId: string): Promise<string[]> {
  const { rows } = await d1.query(
    `select distinct e.address from scope_members m join user_emails e on e.user_id = m.user_id
     where m.scope_id = ? and m.role = 'owner' order by e.address`,
    [scopeId],
  );
  return rows.map((r) => String(r.address));
}

/** A notice that cannot be sent is logged and does not undo the change it reports. */
export async function notifyOwners<K extends NoticeKind>(ports: ProofPorts, scopeId: string, kind: K, data: NoticeData<K>): Promise<void> {
  const results = await Promise.allSettled((await ownerAddresses(ports.d1, scopeId)).map((to) => sendNotice(ports.mail, to, kind, data)));
  for (const r of results) if (r.status === "rejected") console.log(JSON.stringify({ event: "scopes.notice_failed", kind, reason: String(r.reason) }));
}
