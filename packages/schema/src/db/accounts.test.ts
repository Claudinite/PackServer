import { describe, expect, it } from "vitest";
import { migratedDb } from "../../test/migrated-db";

const NOW = "2026-10-23T00:00:00.000Z";

describe("accounts tables", () => {
  const seed = () => {
    const d = migratedDb();
    d.exec(`insert into users (id, created_at) values ('u1', '${NOW}'), ('u2', '${NOW}')`);
    return d;
  };

  it("lets one account hold an address once and no other account hold it", () => {
    const d = seed();
    const add = (user: string, address: string) =>
      d.exec(`insert into user_emails (user_id, address, source, created_at) values ('${user}', '${address}', 'github', '${NOW}')`);
    add("u1", "a@example.test");
    expect(() => add("u1", "a@example.test")).toThrow(/UNIQUE/);
    expect(() => add("u2", "a@example.test")).toThrow(/UNIQUE/);
    add("u2", "b@example.test");
  });

  it("refuses an address for an account that does not exist", () => {
    expect(() =>
      migratedDb().exec(`insert into user_emails (user_id, address, source, created_at) values ('nobody', 'a@example.test', 'github', '${NOW}')`),
    ).toThrow(/FOREIGN KEY/);
  });

  it("records an organisation once per person and lets two people administer one", () => {
    const d = seed();
    const add = (user: string, org: string) =>
      d.exec(`insert into github_org_admins (user_id, github_org_id, github_org_login, observed_at) values ('${user}', '${org}', 'acme', '${NOW}')`);
    add("u1", "100");
    expect(() => add("u1", "100")).toThrow(/UNIQUE/);
    add("u2", "100");
  });
});
