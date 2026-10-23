import { describe, expect, it } from "vitest";
import { chooseHandle, judgeHandle, loadHandleFacts } from "../handles.ts";
import { migratedD1 } from "../testing.ts";

const NOW = "2026-10-23T00:00:00.000Z";
const none = { taken: false, verifiedNames: [] };

describe("IT-ACC-002 handle rules", () => {
  it.each(["admin", "claude", "anthropic", "claudinite", "cn", "fleet", "local", "global", "canon", "temp", "Admin", "c1aude", "cl-aude"])(
    "refuses the reserved name %s",
    (name) => {
      expect(judgeHandle(name, none)).toMatchObject({ ok: false, reason: "reserved" });
    },
  );

  it.each(["", "a", "-ab", "ab-", "a--b", "a_b", "has space", "x".repeat(40), "аdmin"])("refuses the malformed handle %j", (name) => {
    expect(judgeHandle(name, none)).toMatchObject({ ok: false, reason: "format" });
  });

  it("refuses a taken handle and says so", () => {
    expect(judgeHandle("taken", { taken: true, verifiedNames: [] })).toMatchObject({ ok: false, reason: "taken", message: expect.stringContaining("taken") });
  });

  it("refuses the name of a verified organisation, and a confusable or near one", () => {
    const facts = { taken: false, verifiedNames: ["acme"] };
    expect(judgeHandle("acme", facts)).toMatchObject({ ok: false, reason: "reserved", message: expect.stringContaining("verified") });
    expect(judgeHandle("acrne", facts)).toMatchObject({ ok: false, reason: "confusable" });
    expect(judgeHandle("acmee", facts)).toMatchObject({ ok: false, reason: "confusable" });
    expect(judgeHandle("fresh", facts)).toEqual({ ok: true, handle: "fresh" });
  });

  it("does not call short names near each other", () => {
    expect(judgeHandle("ab", { taken: false, verifiedNames: ["ac"] })).toEqual({ ok: true, handle: "ab" });
  });

  it("accepts and lower-cases an ordinary handle", () => {
    expect(judgeHandle("  Fresh-One ", none)).toEqual({ ok: true, handle: "fresh-one" });
  });
});

describe("handles against the database", () => {
  const seed = () => {
    const { d1, db } = migratedD1();
    db.exec(`insert into users (id, handle, created_at) values ('u1', 'taken', '${NOW}'), ('u2', null, '${NOW}'), ('u3', null, '${NOW}')`);
    db.exec(`insert into scopes (id, name, kind, verified_domain, created_at) values ('s1', 'acme', 'org', 'acme.com', '${NOW}')`);
    db.exec(`insert into scopes (id, name, kind, verified_github_org, created_at) values ('s2', 'widgets', 'org', 'widgets-inc', '${NOW}')`);
    db.exec(`insert into retired_names (kind, name, retired_at) values ('scope', 'gone', '${NOW}')`);
    return d1;
  };

  it("reads verified scope names, domain labels and GitHub organisations", async () => {
    const facts = await loadHandleFacts(seed(), "fresh");
    expect(facts.taken).toBe(false);
    expect([...facts.verifiedNames].sort()).toEqual(["acme", "widgets", "widgets-inc"]);
  });

  it("treats another person's handle, a scope name and a retired scope name as taken", async () => {
    const d1 = seed();
    for (const name of ["taken", "gone"]) expect(await chooseHandle(d1, "u2", name)).toMatchObject({ ok: false, reason: "taken" });
    expect((await loadHandleFacts(d1, "widgets")).taken).toBe(true);
  });

  it("claims a handle once, for an account that has none", async () => {
    const d1 = seed();
    expect(await chooseHandle(d1, "u2", "fresh")).toEqual({ ok: true, handle: "fresh" });
    expect(await chooseHandle(d1, "u3", "fresh")).toMatchObject({ ok: false, reason: "taken" });
    expect(await chooseHandle(d1, "u2", "another")).toMatchObject({ ok: false, reason: "taken", message: expect.stringContaining("already has a handle") });
    expect((await d1.query("select handle from users where id = 'u2'")).rows).toEqual([{ handle: "fresh" }]);
  });
});
