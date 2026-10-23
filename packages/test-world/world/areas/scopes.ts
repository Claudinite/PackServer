import { stubModule } from "../errors";
import type { Org, Pack } from "../types";

/** Scopes, organisations and the packs they own. */
export interface ScopesModule {
  packs: {
    public(name: string, opts?: { versions?: string[] }): Promise<Pack>;
    private(name: string): Promise<Pack>;
    nonexistent(name: string): Pack;
    get(name: string): Pack;
  };
  orgs: { get(name: string): Org };
}

export const createScopes = (): ScopesModule => ({ packs: stubModule("packs"), orgs: stubModule("orgs") });
