import type { SelfTestCheck } from "./selftest-runner";

export const ENVIRONMENTS = ["test", "staging", "production"] as const;

export interface LocalSelfTestInput {
  environment: string;
  missingBindings: readonly string[];
  missingSecrets: readonly string[];
}

/** The checks every Worker runs without calling out: configuration, bindings and secrets by name (REQ-OPS-010). */
export function localSelfTestChecks(input: LocalSelfTestInput): SelfTestCheck[] {
  return [
    { name: "config.environment", run: async () => (ENVIRONMENTS as readonly string[]).includes(input.environment) },
    { name: "bindings.present", run: async () => input.missingBindings.length === 0 },
    { name: "secrets.present", run: async () => input.missingSecrets.length === 0 },
  ];
}
