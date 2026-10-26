import { localSelfTestChecks, storeChecks, type SelfTestCheck } from "@packserver/http";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { AdminRuntime } from "./bindings";

export function selfTestChecks(runtime: AdminRuntime): SelfTestCheck[] {
  const { ports } = runtime;
  return [
    ...localSelfTestChecks(runtime),
    ...storeChecks({ d1: ports.d1, kv: ports.kv, r2: ports.r2, schema: { min: SCHEMA_MIN, max: SCHEMA_MAX } }),
    // Fails when AUDIT_S3_ENDPOINT or the token is unset or wrong; env.test has no audit bucket.
    ...(runtime.environment === "test"
      ? []
      : [{ name: "outbound.audit-bucket", run: async () => { await ports.auditBucket.list("audit/", 1); } }]),
  ];
}
