import { localSelfTestChecks, storeChecks, type SelfTestCheck } from "@packserver/http";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { McpRuntime } from "./bindings";

export function selfTestChecks(runtime: McpRuntime): SelfTestCheck[] {
  const { ports } = runtime;
  return [...localSelfTestChecks(runtime), ...storeChecks({ d1: ports.d1, kv: ports.kv, r2: ports.r2, schema: { min: SCHEMA_MIN, max: SCHEMA_MAX } })];
}
