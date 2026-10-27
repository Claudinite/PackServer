import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { migratedD1 } from "../identity/testing";
import { drainLifecycleNotices, MAX_NOTICE_ATTEMPTS } from "./notices";

const NOW = "2026-10-27T00:00:00.000Z";

function setup() {
  const { d1, db } = migratedD1();
  const fakes = createFakePorts();
  db.exec(`insert into users (id, created_at) values ('u1', '${NOW}'), ('u2', '${NOW}'), ('u3', '${NOW}');
    insert into user_emails (user_id, address, source, created_at) values ('u1', 'bad@example.test', 'github', '${NOW}'), ('u2', 'good@example.test', 'github', '${NOW}');
    insert into scopes (id, name, kind, state, created_at) values ('s', 'acme', 'org', 'active', '${NOW}');
    insert into packs (id, scope_id, name, visibility, created_at) values ('p', 's', 'gcp', 'public', '${NOW}')`);
  for (const [i, user] of ["u1", "u2", "u3"].entries()) {
    db.exec(`insert into lifecycle_notices (id, user_id, pack_id, version, action, reason, audience, created_at) values ('n${i}', '${user}', 'p', '1.0.0', 'yanked', 'r', 'stargazer', '${NOW}')`);
  }
  const sent: string[] = [];
  const mail = { send: async (m: { to: string }) => { if (m.to === "bad@example.test") throw new Error("mailbox refused"); sent.push(m.to); } };
  const ports = { d1, clock: fakes.clock };
  return { db, ports, delivery: { mail: mail as never, siteOrigin: "https://registry.test" }, sent };
}

describe("IT-MOD-013 the notice job", () => {
  it("goes on to the next person when one send fails, and gives up on that person after a bound", async () => {
    const { db, ports, delivery, sent } = setup();
    expect(await drainLifecycleNotices(ports, delivery)).toEqual({ sent: 1, skipped: 1, failed: 1 });
    expect(sent).toEqual(["good@example.test"]);
    expect(db.prepare("select id, sent_at is not null as done, attempts from lifecycle_notices order by id").all()).toEqual([
      { id: "n0", done: 0, attempts: 1 },
      { id: "n1", done: 1, attempts: 0 },
      { id: "n2", done: 1, attempts: 0 },
    ]);
    for (let i = 1; i < MAX_NOTICE_ATTEMPTS; i++) await drainLifecycleNotices(ports, delivery);
    expect(await drainLifecycleNotices(ports, delivery)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(sent).toEqual(["good@example.test"]);
  });
});
