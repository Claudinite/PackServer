import type { Ports } from "../src/ports";
import {
  FakeAuditSink, FakeCache, FakeClock, FakeD1, FakeDurableObjects, FakeKV, FakeQueue, FakeR2, FakeRng, FakeStats,
  FakeTransparency, FakeUploads,
} from "./core";
import {
  FakeAccessIdentity, FakeDns, FakeEmbedder, FakeGitHub, FakeMail, FakeOidcVerifier, FakeProseScreen, FakeSandbox,
  FakeTurnstile, FakeVectorIndex,
} from "./external";

export * from "./core";
export * from "./external";

export type FakePorts = { [K in keyof Ports]: Ports[K] } & {
  clock: FakeClock; rng: FakeRng; github: FakeGitHub; oidc: FakeOidcVerifier; vectors: FakeVectorIndex;
  embedder: FakeEmbedder; sandbox: FakeSandbox; proseScreen: FakeProseScreen; mail: FakeMail; dns: FakeDns;
  turnstile: FakeTurnstile; access: FakeAccessIdentity; stats: FakeStats; cache: FakeCache; uploads: FakeUploads;
  audit: FakeAuditSink; transparency: FakeTransparency; d1: FakeD1; r2: FakeR2; kv: FakeKV; queue: FakeQueue;
  durableObjects: FakeDurableObjects;
};

export function createFakePorts(options: { seed?: number } = {}): FakePorts {
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
    r2: new FakeR2(),
    kv: new FakeKV(clock),
    queue: new FakeQueue(),
    durableObjects: new FakeDurableObjects(),
  };
}
