import type { Driver } from "./driver";
import { HttpDriver } from "./http";
import { InProcessDriver } from "./inprocess";

/** `TEST_DRIVER` picks the driver for the run (`inprocess` by default); the runner maps `--driver=` onto it. */
export function createDriver(env: Record<string, string | undefined> = process.env): Driver {
  const kind = env.TEST_DRIVER ?? "inprocess";
  switch (kind) {
    case "inprocess":
      return new InProcessDriver();
    case "http":
      return new HttpDriver();
    default:
      throw new Error(`unknown TEST_DRIVER "${kind}" (inprocess | http)`);
  }
}

export type { Driver, DriverKind, Capability } from "./driver";
