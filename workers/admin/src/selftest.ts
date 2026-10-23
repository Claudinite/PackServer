import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { AdminRuntime } from "./bindings";

export function selfTestChecks(runtime: AdminRuntime): SelfTestCheck[] {
  return [
    ...localSelfTestChecks(runtime),
    // Fails when AUDIT_S3_ENDPOINT or the token is unset or wrong; env.test has no audit bucket.
    ...(runtime.environment === "test"
      ? []
      : [{ name: "outbound.audit-bucket", run: async () => { await runtime.ports.auditBucket.list("audit/", 1); } }]),
  ];
}
