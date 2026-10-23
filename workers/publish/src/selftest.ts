import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { PublishRuntime } from "./bindings";

export function selfTestChecks(runtime: PublishRuntime): SelfTestCheck[] {
  return localSelfTestChecks(runtime);
}
