import type { FakeMail } from "@packserver/ports/fakes";

/** Backs `world.mail.inbox(user)`: the notices an address received, with their links parsed out. */
export function inbox(mail: FakeMail, address: string) {
  return mail.inbox(address).map((m) => ({
    ...m,
    links: [...(m.html ?? "").matchAll(/<a href="([^"]+)"/g)].map((x) => (x[1] ?? "").replace(/&amp;/g, "&")),
  }));
}
