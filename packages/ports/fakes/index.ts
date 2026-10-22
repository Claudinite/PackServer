import type { Ports } from "../src/ports";
import {
  FakeAuditSink, FakeCache, FakeClock, FakeD1, FakeDurableObjects, FakeKV, FakeQueue, FakeR2, FakeRateLimit, FakeRng, FakeStats,
  FakeTransparency, FakeUploads, FakeWorkflow,
} from "./core";
import {
  FakeAccessIdentity, FakeDns, FakeEmbedder, FakeGitHub, FakeMail, FakeOidcVerifier, FakeProseScreen, FakeSandbox,
  FakeTurnstile, FakeVectorIndex,
} from "./external";

export * from "./core";
export * from "./external";

type Fakes = {
  clock: FakeClock; rng: FakeRng; github: FakeGitHub; oidc: FakeOidcVerifier; vectors: FakeVectorIndex;
  embedder: FakeEmbedder; sandbox: FakeSandbox; proseScreen: FakeProseScreen; mail: FakeMail; dns: FakeDns;
  turnstile: FakeTurnstile; access: FakeAccessIdentity; stats: FakeStats; cache: FakeCache; uploads: FakeUploads;
  audit: FakeAuditSink; transparency: FakeTransparency; d1: FakeD1; durableObjects: FakeDurableObjects;
};
export type FakePorts = Fakes & {
  r2: Record<string, FakeR2>;
  kv: Record<string, FakeKV>;
  queues: Record<string, FakeQueue>;
  workflows: Record<string, FakeWorkflow>;
  rateLimits: Record<string, FakeRateLimit>;
};

export interface FakePortsOptions {
  seed?: number;
  /** Binding names; a Worker's real names come from its wrangler.jsonc. */
  r2?: string[];
  kv?: string[];
  queues?: string[];
  workflows?: string[];
  rateLimits?: Record<string, { limit: number; periodMs: number }>;
}

const byName = <T>(names: string[], make: () => T): Record<string, T> => Object.fromEntries(names.map((n) => [n, make()]));

export function createFakePorts(options: FakePortsOptions = {}): FakePorts {
  const clock = new FakeClock();
  return {
    clock,
    rng: new FakeRng(options.seed),
    github: new FakeGitHub(),
    oidc: new FakeOidcVerifier(() => clock.now()),
    vectors: new FakeVectorIndex(),
    embedder: new FakeEmbedder(),
    sandbox: new FakeSandbox(),
    proseScreen: new FakeProseScreen(),
    mail: new FakeMail(),
    dns: new FakeDns(),
    turnstile: new FakeTurnstile(),
    access: new FakeAccessIdentity(),
    stats: new FakeStats(),
    cache: new FakeCache(),
    uploads: new FakeUploads(clock),
    audit: new FakeAuditSink(),
    transparency: new FakeTransparency(),
    d1: new FakeD1(),
    durableObjects: new FakeDurableObjects(),
    r2: byName(options.r2 ?? ["public", "private", "staging", "validation-reports"], () => new FakeR2()),
    kv: byName(options.kv ?? ["sessions", "cache"], () => new FakeKV(clock)),
    queues: byName(options.queues ?? ["notify", "audit"], () => new FakeQueue()),
    workflows: byName(options.workflows ?? ["validate-pack"], () => new FakeWorkflow()),
    rateLimits: Object.fromEntries(
      Object.entries(options.rateLimits ?? { default: { limit: 10, periodMs: 60_000 } }).map(([n, c]) => [
        n,
        new FakeRateLimit(clock, c.limit, c.periodMs),
      ]),
    ),
  };
}

/** Compile-time proof that the fakes satisfy the port interfaces. */
export const asPorts = (fakes: FakePorts): Ports => fakes;
