import type { Driver } from "../../drivers/driver";
import { stubModule } from "../errors";
import { createWorldTokens, type WorldTokens } from "../tokens";
import type { User } from "../types";

export interface PublicKey {
  readonly kid: string;
}

/** Tokens, keys and the private-pack access verbs. */
export interface AccessModule {
  registryKey(which?: "current" | "previous"): PublicKey;
  tokens: WorldTokens;
}

export const createAccess = (driver: Driver): AccessModule => ({
  registryKey: stubModule<Pick<AccessModule, "registryKey">>("world").registryKey,
  tokens: createWorldTokens(driver, async (user: User) => (await user.account.show()).id),
});
