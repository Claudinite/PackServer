import { stubModule } from "../errors";

export interface PublicKey {
  readonly kid: string;
}

/** Tokens, keys and the private-pack access verbs. */
export interface AccessModule {
  registryKey(which?: "current" | "previous"): PublicKey;
  tokens: { leakReport(tokenOrPrefix: string): Promise<void> };
}

export const createAccess = (): AccessModule => ({
  registryKey: stubModule<Pick<AccessModule, "registryKey">>("world").registryKey,
  tokens: stubModule("tokens"),
});
