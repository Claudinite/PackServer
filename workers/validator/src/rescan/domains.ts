import { sendNotice } from "@packserver/core/mail";
import { ownerAddresses } from "@packserver/core/publishing";
import { driftVerdict, linkedDomains } from "@packserver/core/validation";
import type { ValidatorRuntime } from "../bindings";
import { deliverOnce } from "../notify/deliver";
import { metaOf } from "./material";
import { quarantine } from "./quarantine";
import type { Candidate } from "./store";

export const DRIFT_REASON = "domain-drift";

/** A version's domains beyond this many are left for a later rewrite of the inventory; it keeps one version inside a fire's lookup budget. */
const MAX_DOMAINS_PER_VERSION = 100;

/** The resolver lookups one fire may make; the pass picks up at the pack that would exceed it. */
export class LookupBudgetSpent extends Error {}

export interface DomainRun {
  trigger: string;
  lookups: number;
  /** Domains already decided in this fire, so a domain linked by many versions is asked about once. */
  decided: Map<string, boolean>;
}

/**
 * Whether the domain resolves differently from the state the registry last recorded. The first pass
 * to meet a domain records it as the baseline and finds nothing; the answer is stored under the
 * pass's trigger, so every version linking the domain sees the same drift within the week. A
 * resolver that cannot answer throws: it is not an answer of "gone".
 */
async function drifted(rt: ValidatorRuntime, domain: string, run: DomainRun): Promise<boolean> {
  const known = run.decided.get(domain);
  if (known !== undefined) return known;
  const at = new Date(rt.ports.clock.now()).toISOString();
  const row = (await rt.ports.d1.query(`select resolves, checked_trigger, changed_trigger from url_domain_states where domain = ?`, [domain])).rows[0];
  let result: boolean;
  if (row && row.checked_trigger === run.trigger) {
    result = row.changed_trigger === run.trigger;
  } else {
    if (run.lookups <= 0) throw new LookupBudgetSpent();
    run.lookups--;
    const resolves = await rt.ports.dns.resolves(domain);
    result = row !== undefined && (row.resolves === 1) !== resolves;
    await rt.ports.d1.query(
      `insert into url_domain_states (domain, resolves, checked_trigger, changed_trigger, updated_at) values (?, ?, ?, ?, ?)
       on conflict (domain) do update set resolves = excluded.resolves, checked_trigger = excluded.checked_trigger, changed_trigger = excluded.changed_trigger, updated_at = excluded.updated_at`,
      [domain, resolves ? 1 : 0, run.trigger, result ? run.trigger : null, at],
    );
  }
  run.decided.set(domain, result);
  return result;
}

export interface DomainVisit {
  checked: boolean;
  quarantined: boolean;
  warned: number;
}

/** REQ-VAL-018 for one version: its prose's domains, re-resolved. Only a domain an install, fetch or execute instruction points at quarantines. */
export async function rescanDomains(rt: ValidatorRuntime, candidate: Candidate, run: DomainRun): Promise<DomainVisit> {
  const meta = await metaOf(rt, candidate);
  if (!meta) {
    console.log(JSON.stringify({ event: "validator.rescan_unreadable", pack: candidate.pack, version: candidate.version }));
    return { checked: false, quarantined: false, warned: 0 };
  }
  const moved = new Set<string>();
  for (const domain of linkedDomains(meta.url_inventory).slice(0, MAX_DOMAINS_PER_VERSION)) if (await drifted(rt, domain, run)) moved.add(domain);
  const verdict = driftVerdict(meta.url_inventory, moved);

  const at = new Date(rt.ports.clock.now()).toISOString();
  for (const domain of moved) {
    await rt.ports.d1.query(`insert or ignore into version_warnings (version_id, kind, subject, detected_at) values (?, ?, ?, ?)`, [candidate.id, DRIFT_REASON, domain, at]);
  }
  const quarantined = verdict.quarantine.length > 0 && (await quarantine(rt, candidate, DRIFT_REASON));
  if (verdict.warn.length > 0) await mailOwners(rt, candidate, verdict.warn, run.trigger);
  return { checked: true, quarantined, warned: verdict.warn.length };
}

async function mailOwners(rt: ValidatorRuntime, candidate: Candidate, domains: readonly string[], trigger: string): Promise<void> {
  const host = new URL(rt.config.siteOrigin()).host;
  const versionUrl = `https://${host}/packs/${candidate.pack}/versions`;
  const failures: unknown[] = [];
  for (const address of await ownerAddresses(rt.ports.d1, candidate.scope_id)) {
    for (const domain of domains) {
      try {
        await deliverOnce(rt, `${DRIFT_REASON}:${candidate.id}:${domain}:${trigger}:${address}`, () =>
          sendNotice(rt.ports.mail, address, "domain-drift-warning", { pack: candidate.pack, version: candidate.version, domain, versionUrl }),
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) throw failures[0];
}
