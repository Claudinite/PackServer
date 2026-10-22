import type { Driver } from "./driver";
import { HttpDriver } from "./http";
import { InProcessDriver } from "./inprocess";

export function createDriver(): Driver {
  const kind = process.env.TEST_DRIVER ?? "inprocess";
  switch (kind) {
    case "inprocess":
      return new InProcessDriver();
    case "http":
      return new HttpDriver();
    default:
      throw new Error(`unknown TEST_DRIVER "${kind}" (inprocess | http)`);
  }
}
export type { Driver } from "./driver";
