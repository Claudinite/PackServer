import { stubModule } from "../errors";
import type { Member, MemberPolicy } from "../types";

/** A repository running the pinned cn. */
export interface MemberModule {
  member(policy?: MemberPolicy): Member;
}

export const createMember = (): MemberModule => ({ member: stubModule<MemberModule>("world").member });
