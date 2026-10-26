import { localSelfTestChecks, serviceCheck, storeChecks, type SelfTestCheck } from "@packserver/http";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { ValidatorRuntime } from "./bindings";

export function selfTestChecks(runtime: ValidatorRuntime): SelfTestCheck[] {
  const { ports, services } = runtime;
  return [
    ...localSelfTestChecks(runtime),
    ...storeChecks({ d1: ports.d1, kv: ports.kv, r2: ports.r2, schema: { min: SCHEMA_MIN, max: SCHEMA_MAX } }),
    serviceCheck({ callee: "github", binding: services.github, key: runtime.selfTestKey, uuid: () => ports.rng.uuid() }),
  ];
}
