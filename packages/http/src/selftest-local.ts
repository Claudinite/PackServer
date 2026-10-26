import { TRUST_TABLE, type WorkerName } from "@packserver/ports";
import type { SelfTestCheck } from "./selftest-runner";

export const ENVIRONMENTS = ["test", "staging", "production"] as const;

export interface LocalSelfTestInput {
  worker: WorkerName;
  environment: string;
  missingBindings: readonly string[];
  missingSecrets: readonly string[];
}

/** The checks every Worker runs without calling out: configuration, bindings, and each secret by name and never by value (REQ-OPS-010). */
export function localSelfTestChecks(input: LocalSelfTestInput): SelfTestCheck[] {
  return [
    { name: "config.environment", run: async () => (ENVIRONMENTS as readonly string[]).includes(input.environment) },
    { name: "bindings.present", run: async () => input.missingBindings.length === 0 },
    ...TRUST_TABLE[input.worker].secrets.map((name) => ({ name: `secrets.${name}`, run: async () => !input.missingSecrets.includes(name) })),
  ];
}
