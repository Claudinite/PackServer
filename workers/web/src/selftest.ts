import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { WebRuntime } from "./bindings";

export function selfTestChecks(runtime: WebRuntime): SelfTestCheck[] {
  return localSelfTestChecks(runtime);
}
