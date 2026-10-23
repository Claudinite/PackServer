import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { AdminRuntime } from "./bindings";

export function selfTestChecks(runtime: AdminRuntime): SelfTestCheck[] {
  return localSelfTestChecks(runtime);
}
