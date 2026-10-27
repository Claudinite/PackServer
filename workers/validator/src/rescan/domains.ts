import { sendNotice } from "@packserver/core/mail";
import { ownerAddresses } from "@packserver/core/publishing";
import { driftVerdict, linkedDomains } from "@packserver/core/validation";
import { DNS_NAME_UNANSWERED, PortError } from "@packserver/ports";
import type { Meta } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { deliverOnce } from "../notify/deliver";
import { quarantine } from "./quarantine";
import type { Candidate } from "./store";

export const DRIFT_REASON = "domain-drift";

/** A version's domains beyond this many are left for a later rewrite of the inventory; it keeps one version inside a fire's lookup budget. */
const MAX_DOMAINS_PER_VERSION = 100;

/** Bound parameters in one statement are limited; a chunk of domains stays well inside. */
const STATE_CHUNK = 90;

/** The D1 statements the domain pass may issue in one fire; every job of a fire shares one invocation's allowance. */
export const DOMAIN_BUDGET = { queries: 300 };

/** The fire has used its resolver lookups or its D1 statements; the pass picks up at the pack it had not reached. */
export class FireSpent extends Error {}

/** The resolver itself could not be reached, so nothing more can be asked this fire. */
export class ResolverUnreachable extends Error {}

interface DomainState {
  resolves: boolean;
  checked_trigger: string | null;
  changed_trigger: string | null;
}

export interface DomainRun {
  trigger: string;
  lookups: number;
  /** D1 statements still allowed this fire. */
  queries: number;
  /** What the registry last recorded for each domain of the page, null for a domain never seen. */
  states: Map<string, DomainState | null>;
  /** Domains already decided in this fire (null when the resolver could not answer for the name), so a domain linked by many versions is asked about once. */
  decided: Map<string, boolean | null>;
  /** State rows to write when the version in hand is done. */
  pending: Array<{ sql: string; params: unknown[] }>;
}

export const newRun = (trigger: string, lookups: number): DomainRun => ({ trigger, lookups, queries: DOMAIN_BUDGET.queries, states: new Map(), decided: new Map(), pending: [] });

/** The domains of a version's prose that can lapse or change hands. */
export const domainsOf = (meta: Meta): string[] => linkedDomains(meta.url_inventory).slice(0, MAX_DOMAINS_PER_VERSION);

/** Reads the recorded state of every domain of a page in chunked selects, not one statement per domain. */
export async function loadStates(rt: ValidatorRuntime, domains: readonly string[], run: DomainRun): Promise<void> {
  const wanted = [...new Set(domains)].filter((d) => !run.states.has(d));
  for (let i = 0; i < wanted.length; i += STATE_CHUNK) {
    const chunk = wanted.slice(i, i + STATE_CHUNK);
    if (run.queries < 1) throw new FireSpent();
    run.queries--;
    const { rows } = await rt.ports.d1.query(
      `select domain, resolves, checked_trigger, changed_trigger from url_domain_states where domain in (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
    for (const d of chunk) run.states.set(d, null);
    for (const r of rows) {
      run.states.set(String(r.domain), { resolves: r.resolves === 1, checked_trigger: (r.checked_trigger as string | null) ?? null, changed_trigger: (r.changed_trigger as string | null) ?? null });
    }
  }
}

/**
 * Whether the domain resolves differently from the state the registry last recorded; null when the
 * resolver answered with a failure for this name, in which case nothing is recorded and the name is
 * asked again next time. The first pass to meet a domain records it as the baseline and finds
 * nothing; the answer is stored under the pass's trigger, so every version linking the domain sees
 * the same drift within the week. A resolver that cannot be reached throws: it is not an answer of "gone".
 */
async function drifted(rt: ValidatorRuntime, domain: string, run: DomainRun): Promise<boolean | null> {
  if (run.decided.has(domain)) return run.decided.get(domain)!;
  const row = run.states.get(domain) ?? null;
  let result: boolean | null;
  if (row && row.checked_trigger === run.trigger) {
    result = row.changed_trigger === run.trigger;
  } else {
    if (run.lookups <= 0) throw new FireSpent();
    run.lookups--;
    let resolves: boolean;
    try {
      resolves = await rt.ports.dns.resolves(domain);
    } catch (error) {
      if (!(error instanceof PortError && error.code === DNS_NAME_UNANSWERED)) throw new ResolverUnreachable(String(error));
      console.log(JSON.stringify({ event: "validator.rescan_domain_unanswered", domain, reason: error.message }));
      run.decided.set(domain, null);
      return null;
    }
    result = row !== null && row.resolves !== resolves;
    const at = new Date(rt.ports.clock.now()).toISOString();
    run.pending.push({
      sql: `insert into url_domain_states (domain, resolves, checked_trigger, changed_trigger, updated_at) values (?, ?, ?, ?, ?)
            on conflict (domain) do update set resolves = excluded.resolves, checked_trigger = excluded.checked_trigger, changed_trigger = excluded.changed_trigger, updated_at = excluded.updated_at`,
      params: [domain, resolves ? 1 : 0, run.trigger, result ? run.trigger : null, at],
    });
    run.states.set(domain, { resolves, checked_trigger: run.trigger, changed_trigger: result ? run.trigger : null });
  }
  run.decided.set(domain, result);
  return result;
}

async function flush(rt: ValidatorRuntime, run: DomainRun): Promise<void> {
  if (run.pending.length === 0) return;
  const statements = run.pending.splice(0);
  run.queries--;
  await rt.ports.d1.batch(statements);
}

export interface DomainVisit {
  checked: boolean;
  quarantined: boolean;
  warned: number;
}

/** The statements one version's verdict may cost beyond its state rows: warnings, quarantine, owner lookup and the notices. */
const VERDICT_STATEMENTS = 12;

/** REQ-VAL-018 for one version: its prose's domains, re-resolved. Only a domain an install, fetch or execute instruction points at quarantines. */
export async function rescanDomains(rt: ValidatorRuntime, candidate: Candidate, meta: Meta, run: DomainRun): Promise<DomainVisit> {
  if (run.queries < VERDICT_STATEMENTS) throw new FireSpent();
  const moved = new Set<string>();
  try {
    for (const domain of domainsOf(meta)) if ((await drifted(rt, domain, run)) === true) moved.add(domain);
  } finally {
    await flush(rt, run);
  }
  const verdict = driftVerdict(meta.url_inventory, moved);

  const at = new Date(rt.ports.clock.now()).toISOString();
  if (moved.size > 0) {
    run.queries--;
    await rt.ports.d1.batch([...moved].map((domain) => ({ sql: `insert or ignore into version_warnings (version_id, kind, subject, detected_at) values (?, ?, ?, ?)`, params: [candidate.id, DRIFT_REASON, domain, at] })));
  }
  const quarantined = verdict.quarantine.length > 0 && (await quarantine(rt, candidate, DRIFT_REASON));
  if (verdict.warn.length > 0) await mailOwners(rt, candidate, verdict.warn, run.trigger);
  run.queries -= verdict.quarantine.length > 0 || verdict.warn.length > 0 ? 3 + 3 * verdict.warn.length : 0;
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
