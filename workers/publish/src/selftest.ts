import { localSelfTestChecks, coordinatorCheck, serviceCheck, storeChecks, type SelfTestCheck } from "@packserver/http";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { PublishRuntime } from "./bindings";

export function selfTestChecks(runtime: PublishRuntime): SelfTestCheck[] {
  const { ports, services } = runtime;
  return [
    ...localSelfTestChecks(runtime),
    ...storeChecks({ d1: ports.d1, kv: ports.kv, r2: ports.r2, schema: { min: SCHEMA_MIN, max: SCHEMA_MAX } }),
    coordinatorCheck(ports.durableObjects),
    serviceCheck({ callee: "validator", binding: services.validator, key: runtime.selfTestKey, uuid: () => ports.rng.uuid() }),
  ];
}
