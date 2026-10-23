import { stubModule } from "../errors";
import type { Pack, User } from "../types";

/** Reviews, votes, reports and abuse reports, acted as a user. */
export interface CommunityModule {
  review(user: User, pack: Pack, review: { rating: number; body?: string }): Promise<unknown>;
  vote(user: User, pack: Pack, version: string, result: "works" | "fails"): Promise<void>;
  reportAbuse(user: User, target: unknown, o: { category: string; details: string }): Promise<unknown>;
}

export const createCommunity = (): CommunityModule => ({
  review: stubModule<Pick<CommunityModule, "review">>("community").review,
  vote: stubModule<Pick<CommunityModule, "vote">>("community").vote,
  reportAbuse: stubModule<Pick<CommunityModule, "reportAbuse">>("community").reportAbuse,
});
