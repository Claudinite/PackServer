import { stubModule } from "../errors";
import type { Publisher, PublisherOpts, User, UserOpts, Visitor } from "../types";

/** People: members, publishers, anonymous visitors and the personas that name states requirements use. */
export interface UsersModule {
  users: { create(opts?: UserOpts): Promise<User> };
  publishers: { create(opts?: PublisherOpts): Promise<Publisher> };
  personas: {
    verifiedPublisher(name: string): Promise<Publisher>;
    youngUser(): Promise<User>;
    suspendedPublisher(): Promise<Publisher>;
  };
  visitor(): Visitor;
}

export const createUsers = (): UsersModule => ({
  users: stubModule("users"),
  publishers: stubModule("publishers"),
  personas: stubModule("personas"),
  visitor: stubModule<Pick<UsersModule, "visitor">>("world").visitor,
});
