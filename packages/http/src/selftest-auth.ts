import { SELFTEST_SIGNATURE_HEADER, verifySelfTestSignature } from "@packserver/core/selftest";
import { syncClock, type AccessIdentity, type Clock } from "@packserver/ports";
import { candidateGating, type CandidateGatingOptions } from "./candidate-gating";

export const SELFTEST_RATE_LIMIT = 10;
export const SELFTEST_RATE_WINDOW_MS = 60_000;
/** A nonce outlives the signature window on both sides of it. */
const NONCE_TTL_MS = 10 * 60_000;
const NONCE_CAPACITY = 10_000;
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

/** What an isolate remembers between self-test calls: signatures it has seen and what each caller has spent. */
export class SelfTestMemory {
  private readonly nonces = new Map<string, number>();
  private readonly spent = new Map<string, number[]>();

  /** False for a nonce already seen, or when so many are held that remembering one more would mean forgetting another. */
  claimNonce(nonce: string, nowMs: number): boolean {
    for (const [seen, until] of this.nonces) if (until <= nowMs) this.nonces.delete(seen);
    if (this.nonces.has(nonce) || this.nonces.size >= NONCE_CAPACITY) return false;
    this.nonces.set(nonce, nowMs + NONCE_TTL_MS);
    return true;
  }

  /** Counts one call against the principal; false when it already made `SELFTEST_RATE_LIMIT` in the window. */
  spend(principal: string, nowMs: number): boolean {
    const recent = (this.spent.get(principal) ?? []).filter((at) => at > nowMs - SELFTEST_RATE_WINDOW_MS && at <= nowMs);
    if (recent.length >= SELFTEST_RATE_LIMIT) {
      this.spent.set(principal, recent);
      return false;
    }
    this.spent.set(principal, [...recent, nowMs]);
    for (const [other, calls] of this.spent) if (other !== principal && calls.every((at) => at <= nowMs - SELFTEST_RATE_WINDOW_MS)) this.spent.delete(other);
    return true;
  }
}

/** One instance per isolate: a Worker's app is rebuilt for each request, its memory must not be. */
const isolateMemory = new SelfTestMemory();

export type Admission = "granted" | "rate-limited" | "denied";

export interface SelfTestAccess {
  /** Whether the caller may read the self-test: a refusal for an outsider never touches the budget. */
  admit(request: Request): Promise<Admission>;
  /** Whether the request may reach the Worker at all, which a candidate in verification denies to everyone unsigned. */
  open?(request: Request): Promise<boolean>;
}

export interface SelfTestAccessOptions {
  /** The shared signing key; absent leaves only an Access assertion to get in with. */
  key?: () => Promise<string>;
  /** Verifies a Cloudflare Access assertion; absent where the Worker has no such port. */
  access?: AccessIdentity;
  /** The Worker's clock decides the rate-limit window, so a test can move it. */
  clock: Clock;
  /** Signature freshness and nonce lifetime are wall time, which no test clock stands in for. */
  wallClock?: Clock;
  memory?: SelfTestMemory;
}

export interface SelfTestPrincipal {
  /** `access:<sub>` or `key:<key id>`. */
  id: string;
}

const wall: Clock = { now: () => Date.now() };

/** Access service token or signed request, once per request however many times it is asked. */
export function createSelfTestAuth(options: SelfTestAccessOptions) {
  const memory = options.memory ?? isolateMemory;
  const wallClock = options.wallClock ?? wall;
  const known = new WeakMap<Request, Promise<SelfTestPrincipal | null>>();

  async function viaAccess(request: Request): Promise<SelfTestPrincipal | null> {
    const assertion = request.headers.get(ACCESS_ASSERTION_HEADER);
    if (!assertion || !options.access) return null;
    try {
      return { id: `access:${(await options.access.verify(assertion)).sub}` };
    } catch {
      return null;
    }
  }

  async function viaSignature(request: Request): Promise<SelfTestPrincipal | null> {
    const header = request.headers.get(SELFTEST_SIGNATURE_HEADER);
    if (!header || !options.key) return null;
    let key: string;
    try {
      key = await options.key();
    } catch {
      return null;
    }
    const nowMs = wallClock.now();
    const verdict = await verifySelfTestSignature({ header, key, method: request.method, path: new URL(request.url).pathname, nowMs });
    if (!verdict.ok || !memory.claimNonce(verdict.nonce, nowMs)) return null;
    return { id: `key:${verdict.keyId}` };
  }

  function principal(request: Request): Promise<SelfTestPrincipal | null> {
    let answer = known.get(request);
    if (!answer) {
      answer = viaAccess(request).then((byAccess) => byAccess ?? viaSignature(request));
      known.set(request, answer);
    }
    return answer;
  }

  return {
    principal,
    async admit(request: Request): Promise<Admission> {
      const who = await principal(request);
      if (!who) return "denied";
      await syncClock(options.clock);
      return memory.spend(who.id, options.clock.now()) ? "granted" : "rate-limited";
    },
  };
}

/** The slice of a Worker's runtime that decides who may read its self-test. */
export interface SelfTestRuntime {
  worker: string;
  version: { versionId: string; releaseId: string };
  /** Absent where the Worker has no `SELFTEST_HMAC_KEY`; the signed path is then closed. */
  selfTestKey?: () => Promise<string>;
  ports: { clock: Clock; access?: AccessIdentity };
}

export interface SelfTestAccessExtras {
  /** The release manifest, for a Worker that can read `ops`. */
  readManifest?: CandidateGatingOptions["readManifest"];
  memory?: SelfTestMemory;
  wallClock?: Clock;
}

/** Who may read the self-test, and whether a candidate in verification answers anyone else. */
export function selfTestAccess(runtime: SelfTestRuntime, extras: SelfTestAccessExtras = {}): SelfTestAccess {
  const auth = createSelfTestAuth({ key: runtime.selfTestKey, access: runtime.ports.access, clock: runtime.ports.clock, memory: extras.memory, wallClock: extras.wallClock });
  const gated = candidateGating({
    worker: runtime.worker,
    versionId: runtime.version.versionId,
    releaseId: runtime.version.releaseId,
    clock: runtime.ports.clock,
    readManifest: extras.readManifest,
    onState: (state) => console.log(JSON.stringify({ event: "selftest.gating", worker: runtime.worker, state })),
  });
  return {
    admit: auth.admit,
    async open(request) {
      return !(await gated()) || (await auth.principal(request)) !== null;
    },
  };
}
