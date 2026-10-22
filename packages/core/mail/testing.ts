import type { FakeMail } from "@packserver/ports/fakes";

/** Backs `world.mail.inbox(user)`: the notices an address received, with their links parsed out. */
export function inbox(mail: FakeMail, address: string) {
  return mail.inbox(address).map((m) => ({
    ...m,
    links: [...m.text.matchAll(/https?:\/\/[^\s<>"]+/g)].map((x) => x[0]),
  }));
}
