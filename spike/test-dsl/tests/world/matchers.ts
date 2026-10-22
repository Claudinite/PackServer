import { expect } from "vitest";
import type { Outcome } from "../drivers/driver";

// Domain matchers on Outcomes, so scenarios never write try/catch or inspect refusals by hand.
expect.extend({
  toBeNotFound(received: Outcome<unknown>) {
    const pass = !received.ok && received.refusal === "not-found";
    return { pass, message: () => `expected outcome to be not-found, got ${JSON.stringify(received)}` };
  },
  toBeRefused(received: Outcome<unknown>, refusal?: string) {
    const pass = !received.ok && (refusal === undefined || received.refusal === refusal);
    return { pass, message: () => `expected a refusal${refusal ? ` (${refusal})` : ""}, got ${JSON.stringify(received)}` };
  },
  toSucceedWith(received: Outcome<unknown>, expected: unknown) {
    const want = expected && typeof expected === "object" ? expect.objectContaining(expected as object) : expected;
    const pass = received.ok && this.equals(received.value, want);
    return { pass, message: () => `expected success matching ${JSON.stringify(expected)}, got ${JSON.stringify(received)}` };
  },
});

declare module "vitest" {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toBeNotFound(): R;
    toBeRefused(refusal?: "not-found" | "unauthenticated" | "invalid"): R;
    toSucceedWith(expected: unknown): R;
  }
}
