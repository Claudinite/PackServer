import { createPacks, type PacksModule } from "../packs";
import type { Aliases } from "../alias";
import type { Driver } from "../../drivers/driver";
import { createScopeVerbs, type InvitationsModule, type ReviewModule, type OrgHandle, type OrgsModule, type ScopeViewsModule, type TransfersModule } from "../scopes";
import type { Scope, Sensitive, User, UserOpts } from "../types";
import type { UsersModule } from "./users";

/** A person who owns a personal scope and can create organisations. */
export interface ScopeOwner extends User {
  readonly scope: Scope;
  orgs: { create(name: string, o?: Sensitive): Promise<OrgHandle> };
}

/** Scopes, organisations, the packs they own, and the people who manage them. */
export interface ScopesModule {
  packs: PacksModule;
  verifiedPublishers: ReviewModule;
  orgs: OrgsModule;
  transfers: TransfersModule;
  invitations: InvitationsModule;
  profiles: ScopeViewsModule;
  /** A signed-in person with a handle, and so a personal scope. */
  publishers: { create(opts?: UserOpts): Promise<ScopeOwner> };
}

export const createScopes = (driver: Driver, aliases: Aliases, people: Pick<UsersModule, "users">): ScopesModule => {
  const verbs = createScopeVerbs(driver, aliases);
  return {
    packs: createPacks(driver, aliases),
    ...verbs,
    publishers: {
      async create(opts) {
        const user = await people.users.create(opts);
        await user.signIn();
        return Object.assign(Object.create(user) as User, {
          scope: { name: user.handle } satisfies Scope,
          orgs: { create: (name: string, o?: Sensitive) => verbs.orgs.create(user, name, o) },
        });
      },
    },
  };
};
