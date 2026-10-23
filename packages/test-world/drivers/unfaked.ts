import { InfrastructureError } from "../world/errors";
import type { Driver } from "./driver";

/** Calls to hosts no fake claims since the scenario began; a scenario that made any fails. */
export function unfakedCalls(driver: Driver): string[] {
  return driver.fakes?.net.unfaked() ?? [];
}

export class UnfakedCallsError extends InfrastructureError {}

export function assertNoUnfaked(driver: Driver): void {
  const calls = unfakedCalls(driver);
  if (calls.length > 0) throw new UnfakedCallsError(`the system called outside hosts no fake claims: ${calls.join(", ")}`);
}
