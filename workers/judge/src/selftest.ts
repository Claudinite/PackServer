import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { JudgeRuntime } from "./bindings";

export function selfTestChecks(runtime: JudgeRuntime): SelfTestCheck[] {
  return localSelfTestChecks(runtime);
}
