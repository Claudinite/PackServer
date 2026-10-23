import { stubModule } from "../errors";
import type { Driver } from "../../drivers/driver";
import type { SelfTest } from "../types";

export interface Operator {
  selfTest(o?: { shallow?: boolean; worker?: string }): Promise<SelfTest>;
  deployedVersion(): string;
  observedVersions(): ReadonlySet<string>;
  stall(check: string): void;
}

/** The release flow's identity. The version observations are the driver's; the self-test waits for the Workers' self-test tasks. */
export function createOperator(driver: Driver): Operator {
  const stub = stubModule<Pick<Operator, "selfTest" | "stall">>("operator");
  return {
    selfTest: (o) => stub.selfTest(o),
    stall: (check) => stub.stall(check),
    deployedVersion: () => driver.deployedVersion(),
    observedVersions: () => driver.observedVersions(),
  };
}
