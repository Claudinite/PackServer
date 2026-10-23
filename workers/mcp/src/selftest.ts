import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { McpRuntime } from "./bindings";

export function selfTestChecks(runtime: McpRuntime): SelfTestCheck[] {
  return localSelfTestChecks(runtime);
}
