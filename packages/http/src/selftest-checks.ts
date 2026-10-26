import { judgeSchemaHead, schemaCheckName, signSelfTest, SELFTEST_SIGNATURE_HEADER, type SchemaRange } from "@packserver/core/selftest";
import type { D1, DurableObjects, KV, R2Read } from "@packserver/ports";
import type { SelfTestCheck } from "./selftest-runner";

/** The only scope a self-test may touch (REQ-OPS-008). Reads of it prove a binding answers, whether or not the object exists. */
export const CANARY_SCOPE = "@packserver-canary";
const CANARY_KEY = `${CANARY_SCOPE}/selftest`;

export interface StoreChecksInput {
  d1?: D1;
  kv?: Readonly<Record<string, Pick<KV, "get">>>;
  r2?: Readonly<Record<string, Pick<R2Read, "head">>>;
  /** The range this build supports; given wherever `d1` is. */
  schema?: SchemaRange;
}

/** One read-only probe per store the Worker holds: the self-test leaves every store as it found it. */
export function storeChecks(input: StoreChecksInput): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];
  const { d1, schema } = input;
  if (d1 && schema) {
    checks.push({ name: "d1.ping", run: async () => (await d1.query("select 1 as ok")).rows[0]?.ok === 1 });
    checks.push({
      name: "d1.schema",
      run: async () => {
        const applied = (await d1.query("select name from d1_migrations")).rows.map((row) => String(row.name));
        const verdict = judgeSchemaHead(applied, schema);
        return verdict.ok ? true : { ok: false, label: schemaCheckName(verdict.head, schema) };
      },
    });
  }
  for (const [name, store] of Object.entries(input.kv ?? {})) checks.push({ name: `kv.${name}`, run: async () => (await store.get(CANARY_KEY), true) });
  for (const [name, bucket] of Object.entries(input.r2 ?? {})) checks.push({ name: `r2.${name}`, run: async () => (await bucket.head(CANARY_KEY), true) });
  return checks;
}

/** The canary scope's coordinator answers a ping, which writes nothing a scope could see. */
export function coordinatorCheck(durableObjects: DurableObjects): SelfTestCheck {
  return { name: "do.ping", run: async () => (await durableObjects.call("ScopeCoordinator", CANARY_SCOPE, "ping", [])).ok === true };
}

export interface ServiceCheckInput {
  callee: string;
  binding: { fetch(request: Request): Promise<Response> };
  key: (() => Promise<string>) | undefined;
  uuid: () => string;
}

/**
 * Asks a callee for its shallow self-test, so it does not fan out further. The request carries
 * a key id of its own each time: a callee's rate limit is for callers outside, not for the
 * Workers that verify their own dependencies.
 */
export function serviceCheck(input: ServiceCheckInput): SelfTestCheck {
  return {
    name: `service.${input.callee}`,
    run: async () => {
      if (!input.key) return false;
      const host = `${input.callee}.internal`;
      const path = `/${input.callee}/__selftest`;
      const nonce = input.uuid();
      const signature = await signSelfTest({ key: await input.key(), keyId: `svc-${nonce.slice(0, 8)}`, method: "GET", host, path, nowMs: Date.now(), nonce });
      const response = await input.binding.fetch(new Request(`https://${host}${path}?shallow=1`, { headers: { [SELFTEST_SIGNATURE_HEADER]: signature } }));
      return response.status === 200 && ((await response.json()) as { ok?: unknown }).ok === true;
    },
  };
}
