import { stubModule } from "../errors";
import type { Version } from "../types";

/** Appeals and the actions an admin takes on a version or a pack. */
export interface ModerationModule {
  appeal(version: Version, text: string): Promise<unknown>;
  revoke(version: Version, o: { reason: string; security?: boolean }): Promise<void>;
}

export const createModeration = (): ModerationModule => ({
  appeal: stubModule<Pick<ModerationModule, "appeal">>("moderation").appeal,
  revoke: stubModule<Pick<ModerationModule, "revoke">>("moderation").revoke,
});
