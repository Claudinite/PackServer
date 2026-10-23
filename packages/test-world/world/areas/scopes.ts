import { stubModule } from "../errors";
import { createPacks, type PacksModule } from "../packs";
import type { Aliases } from "../alias";
import type { Driver } from "../../drivers/driver";
import type { Org } from "../types";

/** Scopes, organisations and the packs they own. */
export interface ScopesModule {
  packs: PacksModule;
  orgs: { get(name: string): Org };
}

export const createScopes = (driver: Driver, aliases: Aliases): ScopesModule => ({ packs: createPacks(driver, aliases), orgs: stubModule("orgs") });
