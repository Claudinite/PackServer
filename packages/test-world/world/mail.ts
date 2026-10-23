import { inbox as notices } from "@packserver/core/mail/testing";
import type { Driver } from "../drivers/driver";
import { InfrastructureError } from "./errors";

export type Email = ReturnType<typeof notices>[number] & { code: string | undefined };

export interface Inbox {
  readonly address: string;
  all(): Email[];
  latest(): Email;
}

/** Backs `world.mail.inbox(user)`: the notices an address received, with their links and one-time code parsed out. */
export function createMail(driver: Driver) {
  return {
    inbox(user: { email: string }): Inbox {
      if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no mail fake: nothing can read an inbox on a deployment`);
      const fakes = driver.fakes;
      const all = (): Email[] =>
        notices(fakes.ports.mail, user.email).map((m) => ({ ...m, code: /\b\d{6}\b/.exec(m.text)?.[0] }));
      return {
        address: user.email,
        all,
        latest() {
          const last = all().at(-1);
          if (!last) throw new InfrastructureError(`${user.email} has received no mail`);
          return last;
        },
      };
    },
  };
}
