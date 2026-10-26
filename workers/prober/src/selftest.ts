import { localSelfTestChecks, storeChecks, type SelfTestCheck } from "@packserver/http";
import type { ProberRuntime } from "./bindings";

export function selfTestChecks(runtime: ProberRuntime): SelfTestCheck[] {
  return [...localSelfTestChecks(runtime), ...storeChecks({ kv: runtime.ports.kv })];
}
