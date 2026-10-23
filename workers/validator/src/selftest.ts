import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { ValidatorRuntime } from "./bindings";

export function selfTestChecks(runtime: ValidatorRuntime): SelfTestCheck[] {
  return localSelfTestChecks(runtime);
}
