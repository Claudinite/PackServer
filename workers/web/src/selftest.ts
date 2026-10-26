import { localSelfTestChecks, serviceCheck, storeChecks, type SelfTestCheck } from "@packserver/http";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { WebRuntime } from "./bindings";

export function selfTestChecks(runtime: WebRuntime): SelfTestCheck[] {
  const { ports, services, selfTestKey: key } = runtime;
  return [
    ...localSelfTestChecks(runtime),
    ...storeChecks({ d1: ports.d1, kv: ports.kv, r2: ports.r2, schema: { min: SCHEMA_MIN, max: SCHEMA_MAX } }),
    serviceCheck({ callee: "mcp", binding: services.mcp, key, uuid: () => ports.rng.uuid() }),
    serviceCheck({ callee: "publish", binding: services.publish, key, uuid: () => ports.rng.uuid() }),
  ];
}
