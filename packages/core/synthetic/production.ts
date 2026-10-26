/** Words a real secret never carries and a stand-in always does, set off from the letters around them. */
const STAND_IN_WORD = /(^|[^a-z])(test|fake|dummy|example|placeholder|changeme)([^a-z]|$)/i;
/** A long run of one character, as an all-zero sitekey or a padded stub has. */
const LONG_RUN = /(.)\1{15,}/;

/** Whether a secret reads like the value a test world would hold in its place. */
export function looksLikeTestSecret(value: string): boolean {
  return value.length === 0 || STAND_IN_WORD.test(value) || LONG_RUN.test(value);
}

/** The deployment was given a configuration that only the test world may hold. */
export class ProductionConfigError extends Error {
  constructor(readonly binding: string) {
    super(`${binding} holds a value that only the test environment may hold`);
    this.name = "ProductionConfigError";
  }
}

/**
 * REQ-OPS-003: outside `env.test` a secret that looks like a test value is refused, naming the binding
 * and never the value.
 */
export function refuseTestSecret(environment: string, binding: string, value: string): string {
  if (environment !== "test" && looksLikeTestSecret(value)) throw new ProductionConfigError(binding);
  return value;
}
