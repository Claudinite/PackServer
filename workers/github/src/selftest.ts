import { localSelfTestChecks, type SelfTestCheck } from "@packserver/http";
import type { GithubRuntime } from "./bindings";

export function selfTestChecks(runtime: GithubRuntime): SelfTestCheck[] {
  return localSelfTestChecks(runtime);
}
