import { localSelfTestChecks, serviceCheck, storeChecks, type SelfTestCheck } from "@packserver/http";
import type { JudgeRuntime } from "./bindings";

export function selfTestChecks(runtime: JudgeRuntime): SelfTestCheck[] {
  const { ports, services } = runtime;
  return [
    ...localSelfTestChecks(runtime),
    ...storeChecks({ kv: ports.kv }),
    serviceCheck({ callee: "admin", binding: services.admin, key: runtime.selfTestKey, uuid: () => ports.rng.uuid() }),
  ];
}
