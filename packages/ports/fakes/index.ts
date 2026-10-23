import type { Ports } from "../src/ports";
import { bindingNames, rateLimitNames, type WorkerName } from "../src/trust-table";
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
  /** The Worker whose binding names the fakes carry; with none, the names of every Worker. */
  worker?: WorkerName;
  /** Overrides for the binding names the trust table gives. */
  r2?: string[];
  kv?: string[];
  queues?: string[];
  workflows?: string[];
  rateLimits?: Record<string, { limit: number; periodMs: number }>;
}

const DEFAULT_RATE_LIMIT = { limit: 10, periodMs: 60_000 };

const byName = <T>(names: string[], make: () => T): Record<string, T> => Object.fromEntries(names.map((n) => [n, make()]));

export function createFakePorts(options: FakePortsOptions = {}): FakePorts {
  const clock = new FakeClock();
  const { worker } = options;
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
    r2: byName(options.r2 ?? bindingNames("r2", worker), () => new FakeR2()),
    kv: byName(options.kv ?? bindingNames("kv", worker), () => new FakeKV(clock)),
    queues: byName(options.queues ?? bindingNames("queues", worker), () => new FakeQueue()),
    workflows: byName(options.workflows ?? bindingNames("workflows", worker), () => new FakeWorkflow()),
    rateLimits: Object.fromEntries(
      Object.entries(options.rateLimits ?? Object.fromEntries(rateLimitNames(worker).map((n) => [n, DEFAULT_RATE_LIMIT]))).map(([n, c]) => [
        n,
        new FakeRateLimit(clock, c.limit, c.periodMs),
      ]),
    ),
  };
}

/** Compile-time proof that the fakes satisfy the port interfaces. */
export const asPorts = (fakes: FakePorts): Ports => fakes;
