import { dohDns, wellKnownPort } from "@packserver/ports/domain-proof";
import type { D1, D1Result, Rng } from "@packserver/ports";
import { isPublicSuffix, recheckDomains, sweepGithubProofs, type ProofPorts } from "@packserver/core/scopes";
import { expireSyntheticVersions } from "@packserver/core/synthetic";
import type { Driver } from "../drivers/driver";
import type { Aliases } from "./alias";
import { InfrastructureError, NotImplemented } from "./errors";

/** The system's spelling of a domain a scenario wrote: its registrable label is aliased like a scope name, so `acme.com` still matches the scope `acme`. */
export function systemDomain(aliases: Aliases, domain: string): string {
  const labels = domain.toLowerCase().split(".");
  if (isPublicSuffix(domain.toLowerCase())) return domain.toLowerCase();
  for (let i = 1; i < labels.length; i++) {
    if (isPublicSuffix(labels.slice(i).join("."))) {
      const out = [...labels];
      out[i - 1] = aliases.alias(labels[i - 1]!);
      return out.join(".");
    }
  }
  return domain.toLowerCase();
}

/** Real randomness: ids and tokens must differ between scenarios that share one database. */
const cryptoRng: Rng = {
  float: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296,
  uuid: () => crypto.randomUUID(),
  bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};

interface Statement {
  bind(...values: unknown[]): { all(): Promise<{ results: unknown[]; meta: { changes?: number; last_row_id?: number } }> };
}
interface Db {
  prepare(sql: string): Statement;
  batch(statements: unknown[]): Promise<Array<{ results: unknown[]; meta: { changes?: number; last_row_id?: number } }>>;
}

const shaped = (r: { results: unknown[]; meta: { changes?: number; last_row_id?: number } }): D1Result => ({
  rows: r.results as Array<Record<string, unknown>>,
  meta: { changes: r.meta.changes ?? 0, last_row_id: r.meta.last_row_id ?? null },
});

/** The registry database as the Workers see it, behind the D1 port the shipped functions take. */
export async function registryD1(driver: Driver): Promise<D1> {
  if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver has no storage seam`);
  const db = (await driver.storage()).db as unknown as Db;
  return {
    query: async (sql, params = []) => shaped(await db.prepare(sql).bind(...params).all()),
    batch: async (statements) => (await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))))).map(shaped),
  };
}

/**
 * The ports the shipped proof functions take when the World runs them itself (the cron jobs and the
 * admin's review): the same adapters the Workers use, over the same fakes, at the fake clock's instant.
 */
export async function proofPortsOf(driver: Driver): Promise<ProofPorts> {
  const fakes = driver.fakes;
  if (!fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fakes: the registry's jobs cannot be run from here`);
  const now = await fakes.clock.call<number>("now");
  const reindex = fakes.ports.queues["REINDEX_QUEUE"];
  if (!reindex) throw new InfrastructureError("the fake ports have no reindex queue");
  return {
    d1: await registryD1(driver),
    clock: { now: () => now },
    rng: cryptoRng,
    dns: dohDns(),
    wellKnown: wellKnownPort(),
    mail: fakes.ports.mail,
    reindex,
    siteOrigin: "https://registry.test.invalid",
  };
}

const CHALLENGE_LABEL = "_packserver-challenge";
const AUTH_FILE_PATH = "/.well-known/packserver-auth";

/** The outside a domain proof meets, spoken in the scenario's own domain names. */
export interface DnsModule {
  /** Adds a TXT record at the proof's name for `domain`. */
  publishTxt(domain: string, value: string): void;
  /** Takes every record off the proof's name for `domain`. */
  remove(domain: string): void;
  /** `host` serves `body` as its proof file. */
  serveFile(host: string, body: string): void;
  /** `host` answers the proof file with a redirect. */
  redirectFile(host: string): void;
  /** `host` answers the proof file with a body of this many bytes. */
  oversizeFile(host: string, bytes: number): void;
  /** `host` does not answer at all. */
  hostDown(host: string): void;
  /** Every resolver query is answered with a failure until `false`. */
  failResolver(down: boolean): void;
  /** Requests that reached a host other than the resolver since the scenario began, and whether each asked for the proof file. */
  hostRequests(): Array<{ host: string; asked: "proof file" | "something else" }>;
  /** The domain names a lookup was made for. */
  lookups(): string[];
}

export function createDns(driver: Driver, aliases: Aliases): DnsModule {
  const domains = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fake DNS`);
    return driver.fakes.domains;
  };
  const sys = (domain: string): string => systemDomain(aliases, domain);
  return {
    publishTxt: (domain, value) => domains().publishTxt(`${CHALLENGE_LABEL}.${sys(domain)}`, value),
    remove: (domain) => domains().removeTxt(`${CHALLENGE_LABEL}.${sys(domain)}`),
    serveFile: (host, body) => domains().serve(sys(host), { kind: "file", body }),
    redirectFile: (host) => domains().serve(sys(host), { kind: "redirect" }),
    oversizeFile: (host, bytes) => domains().serve(sys(host), { kind: "oversize", bytes }),
    hostDown: (host) => domains().serve(sys(host), { kind: "down" }),
    failResolver: (down) => domains().failResolver(down),
    hostRequests: () =>
      domains()
        .requests()
        .filter((r) => !r.host.startsWith("cloudflare-dns."))
        .map((r) => ({ host: aliases.unalias(r.host), asked: r.path === AUTH_FILE_PATH ? ("proof file" as const) : ("something else" as const) })),
    lookups: () =>
      domains()
        .requests()
        .filter((r) => r.host.startsWith("cloudflare-dns."))
        .map((r) => aliases.unalias(r.path.replace(/^.*name=/, ""))),
  };
}

/** The jobs the registry's own schedule runs, started on demand by running the shipped function over the fakes. */
export function createCron(driver: Driver): { run(job: CronJob): Promise<void> } {
  return {
    async run(job) {
      if (job === "domain-rechecks") await recheckDomains(await proofPortsOf(driver));
      else if (job === "github-proof-lapse") await sweepGithubProofs(await proofPortsOf(driver));
      else if (job === "synthetic-expiry") await expireSyntheticVersions(await registryD1(driver), await driver.fakes!.clock.call<number>("now"));
      else throw new NotImplemented(`cron.run(${job})`);
    },
  };
}

export type CronJob =
  | "domain-rechecks" | "github-proof-lapse" | "synthetic-expiry" | "stats-rollup" | "staging-expiry" | "rescan" | "domain-drift"
  | "adoption-scan" | "audit-head" | "audit-verify" | "activity-prune";
