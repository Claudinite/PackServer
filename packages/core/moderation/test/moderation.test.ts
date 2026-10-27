import { FakeMail, FakeQueue } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createAudit } from "../../audit/index.ts";
import { transitionVersion } from "../../publishing/lifecycle.ts";
import { migratedD1 } from "../../identity/testing.ts";
import type { SignalAttrs, SignalName } from "../../telemetry/index.ts";
import {
  actOnAbuse, businessDaysBetween, decideModerationAppeal, dismissAbuse, fileAbuseReport, fileAppeal, fileCounterNotice, heldComments, openAbuseReports,
  moveVersion, prioritisedAttrs, recordDismissals, recordSuit, releaseComment, removeComment, removeOnCopyrightNotice, closeCopyrightCase, sweepDmca, hidePack, suspendPublisher, blockReporter, type AbuseInput, type ModerationPorts,
} from "../index.ts";

const START = Date.parse("2026-10-23T10:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function fixture(declared: number | null = 3) {
  const { d1 } = migratedD1();
  let now = START;
  let n = 0;
  const mail = new FakeMail();
  const signals: Array<{ name: SignalName; attrs: SignalAttrs }> = [];
  const clock = { now: () => now };
  const rng = { uuid: () => `id-${++n}`, float: () => 0.5, bytes: (len: number) => new Uint8Array(len).fill(++n % 256) };
  const ports: ModerationPorts = {
    clock, rng, d1, mail, reindex: new FakeQueue(),
    audit: createAudit({ clock, rng, queue: new FakeQueue(), d1 }, { ipKey: "" }),
    emit: (name, attrs) => void signals.push({ name, attrs }),
    siteOrigin: "https://registry.test",
  };
  const at = iso(START - 200 * DAY);
  await d1.batch([
    { sql: "insert into scopes (id, name, kind, state, created_at) values ('scope-acme', 'acme', 'org', 'active', ?)", params: [at] },
    { sql: "insert into packs (id, scope_id, name, visibility, created_at) values ('pack-gcp', 'scope-acme', 'gcp', 'public', ?)", params: [at] },
    { sql: "insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified) values ('v1', 'pack-gcp', '1.0.0', 'active', 'sha', 10, ?, 0, 0)", params: [at] },
  ]);
  if (declared !== null) {
    await d1.query("insert into adoption_scans (id, started_at, updated_at, completed_at) values ('scan', ?, ?, ?)", [at, at, at]);
    for (let i = 0; i < declared; i++) await d1.query("insert into pack_declarations (scan_id, pack, repository, owner, settings_path) values ('scan', '@acme/gcp', ?, ?, 's')", [`r${i}`, `o${i}`]);
  }
  const user = async (id: string, o: { age?: number; role?: string; adopts?: boolean } = {}) => {
    await d1.batch([
      { sql: "insert into users (id, handle, created_at) values (?, ?, ?)", params: [id, id, iso(START - (o.age ?? 40) * DAY)] },
      { sql: "insert into user_emails (user_id, address, source, created_at) values (?, ?, 'github', ?)", params: [id, `${id}@example.test`, at] },
      ...(o.role ? [{ sql: "insert into scope_members (scope_id, user_id, role, created_at) values ('scope-acme', ?, ?, ?)", params: [id, o.role, at] }] : []),
      ...(o.adopts ? [{ sql: "insert into authenticated_downloads (pack_id, user_id, last_at) values ('pack-gcp', ?, ?)", params: [id, iso(START)] }] : []),
    ]);
    return id;
  };
  const report = (who: string, details: string, category: AbuseInput["category"] = "malware") => fileAbuseReport(ports, who, { kind: "pack", target: "@acme/gcp", category, details });
  const state = async () => String((await d1.query("select state from pack_versions where id = 'v1'")).rows[0]?.state);
  return { d1, ports, mail, signals, user, report, state, advance: (ms: number) => void (now += ms) };
}

describe("business days", () => {
  it("counts the weekdays after the day it starts", () => {
    const thursday = Date.parse("2026-10-22T09:00:00Z");
    expect(businessDaysBetween(thursday, Date.parse("2026-10-23T09:00:00Z"))).toBe(1);
    expect(businessDaysBetween(thursday, Date.parse("2026-10-26T09:00:00Z"))).toBe(2);
    expect(businessDaysBetween(thursday, Date.parse("2026-11-05T09:00:00Z"))).toBe(10);
    expect(businessDaysBetween(thursday, Date.parse("2026-11-11T09:00:00Z"))).toBe(14);
  });

  it("is zero on the day itself and across a weekend", () => {
    expect(businessDaysBetween(Date.parse("2026-10-23T09:00:00Z"), Date.parse("2026-10-23T23:00:00Z"))).toBe(0);
    expect(businessDaysBetween(Date.parse("2026-10-23T09:00:00Z"), Date.parse("2026-10-25T23:00:00Z"))).toBe(0);
  });
});

describe("the signals the judge reads", () => {
  it("leaves declared_by out when the count is unknown", () => {
    expect(prioritisedAttrs({ id: "r", pack: "@a/b", version: "1.0.0", declaredBy: null })).toEqual({ report: "r", pack: "@a/b", version: "1.0.0" });
    expect(prioritisedAttrs({ id: "r", pack: "@a/b", version: "1.0.0", declaredBy: 0 })).toHaveProperty("declared_by", 0);
  });

  it("emits report_prioritised with an integer count from a real filing, and not for a low-severity category", async () => {
    const f = await fixture(12);
    const who = await f.user("s4");
    await f.report(who, "spam words", "spam");
    expect(f.signals.filter((s) => s.name === "moderation.report_prioritised")).toEqual([]);
    await f.report(who, "downloads a binary");
    const [row] = f.signals.filter((s) => s.name === "moderation.report_prioritised");
    expect(row?.attrs).toEqual({ report: expect.any(String), pack: "@acme/gcp", version: "1.0.0", declared_by: 12 });
    expect(Number.isInteger(row?.attrs.declared_by)).toBe(true);
  });

  it("omits the count when no scan has completed", async () => {
    const f = await fixture(null);
    await f.report(await f.user("s4"), "downloads a binary");
    const [row] = f.signals.filter((s) => s.name === "moderation.report_prioritised");
    expect(row?.attrs).not.toHaveProperty("declared_by");
  });

  it("emits takedown_completed with the report when a person acts", async () => {
    const f = await fixture(3);
    const other = await f.user("s1", { adopts: true });
    const filed = await f.report(other, "first");
    if (!filed.ok) throw new Error("not filed");
    await actOnAbuse(f.ports, "admin@example.test", filed.report.id, { action: "quarantine", reason: "Held" });
    expect(f.signals.filter((s) => s.name === "moderation.takedown_completed").map((s) => s.attrs)).toEqual([{ report: filed.report.id }]);
  });
});

describe("standing", () => {
  it("holds on three reporters with standing and not on a scope member's report", async () => {
    const f = await fixture(3);
    const member = await f.user("m", { role: "maintainer", adopts: true });
    const [a, b, c] = [await f.user("a", { adopts: true }), await f.user("b", { adopts: true }), await f.user("c", { adopts: true })] as const;
    await f.report(member, "from the inside");
    await f.report(a, "one");
    await f.report(b, "two");
    expect(await f.state()).toBe("active");
    await f.report(c, "three");
    expect(await f.state()).toBe("quarantined");
    const held = f.signals.filter((x) => x.name === "moderation.quarantined").map((x) => x.attrs);
    expect(held).toHaveLength(4);
    for (const attrs of held) expect(attrs).toEqual({ report: expect.any(String), pack: "@acme/gcp", version: "1.0.0", reason: "abuse_standing" });
  });

  it("does not count an account under 30 days, or one without an adoption or a promoted pack", async () => {
    const f = await fixture(3);
    const young = await f.user("y", { age: 29, adopts: true });
    const bare = await f.user("b");
    const good = await f.user("g", { adopts: true });
    for (const [who, text] of [[young, "1"], [bare, "2"], [good, "3"]] as const) await f.report(who, text);
    expect(await f.state()).toBe("active");
  });

  it("loses standing for 90 days from the second dismissal, not from the first", async () => {
    const f = await fixture(3);
    const d = await f.user("d", { adopts: true });
    const dismiss = (i: number, ago: number) =>
      f.d1.query("insert into abuse_reports (id, target_kind, target_id, reporter_id, category, details, details_key, state, decided_at, created_at) values (?, 'profile', 'x', ?, 'spam', 'x', ?, 'dismissed', ?, ?)", [`old-${i}`, d, `k${i}`, iso(START - ago), iso(START - ago)]);
    await dismiss(0, 80 * DAY);
    await dismiss(1, 0);
    await recordDismissals(f.d1, [d], START);
    const [a, b] = [await f.user("a", { adopts: true }), await f.user("b", { adopts: true })] as const;
    await f.report(a, "1");
    await f.report(b, "2");
    f.advance(11 * DAY);
    await f.report(d, "3");
    expect(await f.state()).toBe("active");
    f.advance(80 * DAY);
    const e = await f.user("e", { adopts: true });
    await f.report(e, "4");
    expect(await f.state()).toBe("quarantined");
  });

  it("never holds a version declared by more than 100 repositories or an unknown number", async () => {
    for (const declared of [101, null]) {
      const f = await fixture(declared);
      for (const id of ["a", "b", "c", "d"]) await f.report(await f.user(id, { adopts: true }), `text ${id}`);
      expect(await f.state()).toBe("active");
    }
  });
});

describe("collapse", () => {
  it("shows identical reports once with their count and counts none of them as standing", async () => {
    const f = await fixture(3);
    for (const id of ["a", "b", "c", "d"]) await f.report(await f.user(id, { adopts: true }), "Same   words");
    expect(await f.state()).toBe("active");
    expect(await openAbuseReports(f.d1)).toMatchObject([{ count: 4, priority: true }]);
  });

  it("refuses the same person saying the same thing twice", async () => {
    const f = await fixture(3);
    const a = await f.user("a");
    await f.report(a, "Same words");
    expect(await f.report(a, "same WORDS")).toMatchObject({ ok: false, reason: "duplicate" });
  });
});

describe("actions, appeals and dismissals", () => {
  it("lifts a provisional hold when a person dismisses the report, and tells the reporter it was closed", async () => {
    const f = await fixture(3);
    const filed = await f.report(await f.user("vp-less", { adopts: true }), "x");
    if (!filed.ok) throw new Error("not filed");
    await f.d1.query("update pack_versions set state = 'quarantined', status_reason = 'held' where id = 'v1'");
    await f.d1.query("insert into moderation_actions (id, scope_id, pack_id, version, kind, reason, trigger, actor, taken_at, from_state, to_state, to_reason) values ('act', 'scope-acme', 'pack-gcp', '1.0.0', 'quarantine', 'held', 'judge', 'system', ?, 'active', 'quarantined', 'held')", [iso(START)]);
    await dismissAbuse(f.ports, filed.report.id, "admin@example.test");
    expect(await f.state()).toBe("active");
    expect(f.mail.inbox("vp-less@example.test").map((m) => m.subject)).toEqual(["Update on your report about @acme/gcp"]);
  });

  it("allows one appeal per action; upheld restores, denied is final", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    const filed = await f.report(await f.user("r"), "x");
    if (!filed.ok) throw new Error("not filed");
    expect(await actOnAbuse(f.ports, "admin@example.test", filed.report.id, { action: "yank", reason: "malware" })).toEqual({ ok: true });
    expect(String((await f.d1.query("select status_reason from pack_versions where id = 'v1'")).rows[0]?.status_reason)).toBe("Removed by PackServer: malware");
    const action = String((await f.d1.query("select id from moderation_actions")).rows[0]?.id);
    expect(await fileAppeal(f.ports, action, "stranger", "x")).toMatchObject({ ok: false, reason: "not_found" });
    expect(await fileAppeal(f.ports, action, owner, "It is fine")).toEqual({ ok: true });
    expect(await fileAppeal(f.ports, action, owner, "again")).toMatchObject({ ok: false, reason: "already_appealed" });
    expect(await decideModerationAppeal(f.ports, action, "admin@example.test", "denied")).toMatchObject({ ok: true });
    expect(await fileAppeal(f.ports, action, owner, "again")).toMatchObject({ ok: false, message: "The decision on the appeal is final." });
    expect(await f.state()).toBe("yanked");
  });

  it("upholding an appeal restores an active version and leaves a revoked one revoked", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    await removeOnCopyrightNotice(f.ports, "admin@example.test", { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    expect(await f.state()).toBe("quarantined");
    await f.d1.query("insert into moderation_actions (id, scope_id, pack_id, version, kind, reason, trigger, actor, taken_at, from_state, to_state, to_reason) values ('q', 'scope-acme', 'pack-gcp', '1.0.0', 'quarantine', 'held', 'admin', 'a', ?, 'active', 'quarantined', 'held')", [iso(START)]);
    await f.d1.query("update pack_versions set state = 'revoked' where id = 'v1'");
    await fileAppeal(f.ports, "q", owner, "fine");
    await decideModerationAppeal(f.ports, "q", "admin@example.test", "upheld");
    expect(await f.state()).toBe("revoked");
  });
});

describe("copyright removals", () => {
  it("restores 14 business days after the counter-notice unless suit is notified, and sends nothing to GitHub", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    const removed = await removeOnCopyrightNotice(f.ports, "admin@example.test", { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    if (!removed.ok) throw new Error("not removed");
    expect(String((await f.d1.query("select status_reason from pack_versions where id = 'v1'")).rows[0]?.status_reason)).toBe("Removed by PackServer: copyright notice");
    expect(await fileAppeal(f.ports, removed.action_id, owner, "mine")).toMatchObject({ ok: false, reason: "counter_notice" });
    expect(await fileCounterNotice(f.ports, removed.action_id, owner, "I wrote it")).toEqual({ ok: true });
    expect(f.mail.inbox("c@claim.test").map((m) => m.subject)).toEqual(["Counter-notice for @acme/gcp 1.0.0"]);
    f.advance(13 * DAY);
    expect(await sweepDmca(f.ports)).toEqual({ restored: 0 });
    f.advance(8 * DAY);
    expect(await sweepDmca(f.ports)).toEqual({ restored: 1 });
    expect(await f.state()).toBe("active");
  });

  it("keeps the version removed once suit is notified", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    const removed = await removeOnCopyrightNotice(f.ports, "admin@example.test", { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    if (!removed.ok) throw new Error("not removed");
    await fileCounterNotice(f.ports, removed.action_id, owner, "I wrote it");
    const caseId = String((await f.d1.query("select id from dmca_cases")).rows[0]?.id);
    expect(await recordSuit(f.ports, caseId, "admin@example.test")).toEqual({ ok: true });
    f.advance(30 * DAY);
    expect(await sweepDmca(f.ports)).toEqual({ restored: 0 });
    expect(await f.state()).toBe("quarantined");
  });
});

describe("held comments", () => {
  async function held(f: Awaited<ReturnType<typeof fixture>>) {
    const author = await f.user("author");
    await f.d1.query("insert into comments (id, pack_id, section, version, user_id, body, created_at, held_at) values ('c1', 'pack-gcp', 's', '1.0.0', ?, 'body', ?, ?)", [author, iso(START), iso(START)]);
  }

  it("lists held comments, releases one and removes another, each audited", async () => {
    const f = await fixture(3);
    await held(f);
    await f.d1.query("insert into comments (id, pack_id, section, version, user_id, body, created_at, held_at) values ('c2', 'pack-gcp', 's', '1.0.0', 'author', 'other', ?, ?)", [iso(START), iso(START)]);
    expect((await heldComments(f.d1)).map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(await releaseComment(f.ports, "c1", "admin@example.test")).toEqual({ ok: true });
    expect(await removeComment(f.ports, "c2", "admin@example.test", "credential")).toEqual({ ok: true });
    expect(await heldComments(f.d1)).toEqual([]);
    expect(await releaseComment(f.ports, "c1", "admin@example.test")).toEqual({ ok: false, reason: "not_held" });
    expect(await releaseComment(f.ports, "nope", "admin@example.test")).toEqual({ ok: false, reason: "unknown" });
    const verbs = (await f.d1.query("select detail from recent_activity order by at, id")).rows.map((r) => (JSON.parse(String(r.detail)) as { verb: string }).verb);
    expect(verbs).toEqual(["comment.release", "comment.remove"]);
  });
});

describe("the yank prefix", () => {
  it("is added to a moderator's yank and not to a publisher's", async () => {
    const f = await fixture(3);
    const reasonOf = async () => String((await f.d1.query("select status_reason from pack_versions where id = 'v1'")).rows[0]?.status_reason);
    await transitionVersion(f.ports, "yank", { pack: "@acme/gcp", version: "1.0.0", reason: "broken" });
    expect(await reasonOf()).toBe("broken");
    await f.d1.query("update pack_versions set state = 'active', status_reason = null where id = 'v1'");
    await moveVersion(f.ports, { kind: "admin", id: "admin@example.test" }, { pack: "@acme/gcp", version: "1.0.0", transition: "yank", reason: "malware" });
    expect(await reasonOf()).toBe("Removed by PackServer: malware");
  });
});

describe("one decision, one report", () => {
  it("dismissing a junk report leaves a standing hold and the other reports alone", async () => {
    const f = await fixture(3);
    const sockless = [await f.user("a", { adopts: true }), await f.user("b", { adopts: true }), await f.user("c", { adopts: true })] as const;
    for (const who of sockless) await f.report(who, `text ${who}`);
    expect(await f.state()).toBe("quarantined");
    const junk = await f.report(await f.user("j"), "junk", "spam");
    if (!junk.ok) throw new Error("not filed");
    await dismissAbuse(f.ports, junk.report.id, "admin@example.test");
    expect(await f.state()).toBe("quarantined");
    expect((await f.d1.query("select count(*) as n from abuse_reports where state = 'open'")).rows[0]?.n).toBe(3);
  });

  it("lifts a standing hold once the reports that justified it are gone, and charges only those reporters", async () => {
    const f = await fixture(3);
    const ids = ["a", "b", "c"];
    const filed = [];
    for (const id of ids) filed.push(await f.report(await f.user(id, { adopts: true }), `text ${id}`));
    expect(await f.state()).toBe("quarantined");
    for (const r of filed) if (r.ok) await dismissAbuse(f.ports, r.report.id, "admin@example.test");
    expect(await f.state()).toBe("active");
    const bystander = await f.report(await f.user("z", { adopts: true }), "other words");
    if (!bystander.ok) throw new Error("not filed");
    await dismissAbuse(f.ports, bystander.report.id, "admin@example.test");
    expect((await f.d1.query("select count(*) as n from abuse_reports where reporter_id = 'z' and state = 'dismissed'")).rows[0]?.n).toBe(1);
  });

  it("keeps a judge hold while another prioritised report is still open", async () => {
    const f = await fixture(3);
    const one = await f.report(await f.user("a"), "one");
    const two = await f.report(await f.user("b"), "two");
    if (!one.ok || !two.ok) throw new Error("not filed");
    await f.d1.query("update pack_versions set state = 'quarantined', status_reason = 'held' where id = 'v1'");
    await f.d1.query("insert into moderation_actions (id, scope_id, pack_id, version, kind, reason, trigger, actor, taken_at, from_state, to_state, to_reason) values ('act', 'scope-acme', 'pack-gcp', '1.0.0', 'quarantine', 'held', 'judge', 'system', ?, 'active', 'quarantined', 'held')", [iso(START)]);
    await dismissAbuse(f.ports, one.report.id, "admin@example.test");
    expect(await f.state()).toBe("quarantined");
    await dismissAbuse(f.ports, two.report.id, "admin@example.test");
    expect(await f.state()).toBe("active");
  });
});

describe("undoing an action", () => {
  async function appealed(f: Awaited<ReturnType<typeof fixture>>, action: string) {
    const owner = await f.user("own", { role: "owner" });
    await fileAppeal(f.ports, action, owner, "fine");
    return decideModerationAppeal(f.ports, action, "admin@example.test", "upheld");
  }

  it("returns a deprecated version to deprecated", async () => {
    const f = await fixture(3);
    await f.d1.query("update pack_versions set state = 'deprecated', status_reason = 'old' where id = 'v1'");
    await moveVersion(f.ports, { kind: "admin", id: "admin@example.test" }, { pack: "@acme/gcp", version: "1.0.0", transition: "quarantine", reason: "Looking" });
    const id = String((await f.d1.query("select id from moderation_actions")).rows[0]?.id);
    await appealed(f, id);
    expect(await f.state()).toBe("deprecated");
    expect(String((await f.d1.query("select status_reason from pack_versions where id = 'v1'")).rows[0]?.status_reason)).toBe("old");
  });

  it("leaves a version another hold took over where it is", async () => {
    const f = await fixture(3);
    await moveVersion(f.ports, { kind: "admin", id: "admin@example.test" }, { pack: "@acme/gcp", version: "1.0.0", transition: "quarantine", reason: "Looking" });
    const id = String((await f.d1.query("select id from moderation_actions")).rows[0]?.id);
    await f.d1.query("update pack_versions set status_reason = 'rescan: new finding' where id = 'v1'");
    await appealed(f, id);
    expect(await f.state()).toBe("quarantined");
  });

  it("re-holds a version already quarantined under the copyright reason, and the sweep puts the earlier quarantine back", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    const reasonOf = async () => String((await f.d1.query("select status_reason from pack_versions where id = 'v1'")).rows[0]?.status_reason);
    await f.d1.query("update pack_versions set state = 'quarantined', status_reason = 'rescan' where id = 'v1'");
    const removed = await removeOnCopyrightNotice(f.ports, "admin@example.test", { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    if (!removed.ok) throw new Error("not removed");
    expect(await reasonOf()).toBe("Removed by PackServer: copyright notice");
    await fileCounterNotice(f.ports, removed.action_id, owner, "mine");
    f.advance(30 * DAY);
    expect(await sweepDmca(f.ports)).toEqual({ restored: 1 });
    expect(await f.state()).toBe("quarantined");
    expect(await reasonOf()).toBe("rescan");
  });

  it("refuses to lift the earlier quarantine while the case is open, and lifts it once the case has resolved", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    const admin = { kind: "admin" as const, id: "admin@example.test" };
    await f.d1.query("update pack_versions set state = 'quarantined', status_reason = 'rescan' where id = 'v1'");
    const removed = await removeOnCopyrightNotice(f.ports, "admin@example.test", { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    if (!removed.ok) throw new Error("not removed");
    expect(await moveVersion(f.ports, admin, { pack: "@acme/gcp", version: "1.0.0", transition: "unquarantine", reason: "cleared" })).toMatchObject({ ok: false });
    expect(await f.state()).toBe("quarantined");
    await fileCounterNotice(f.ports, removed.action_id, owner, "mine");
    f.advance(30 * DAY);
    await sweepDmca(f.ports);
    expect(await moveVersion(f.ports, admin, { pack: "@acme/gcp", version: "1.0.0", transition: "unquarantine", reason: "cleared" })).toMatchObject({ ok: true, changed: true });
    expect(await f.state()).toBe("active");
  });

  it("bounds a sweep and carries the rest to the next", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    const removed = await removeOnCopyrightNotice(f.ports, "admin@example.test", { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    if (!removed.ok) throw new Error("not removed");
    await fileCounterNotice(f.ports, removed.action_id, owner, "mine");
    f.advance(30 * DAY);
    expect(await sweepDmca(f.ports)).toEqual({ restored: 1 });
    expect(await sweepDmca(f.ports)).toEqual({ restored: 0 });
  });

  it("suspends with an appealable action and lifts only the suspension when upheld", async () => {
    const f = await fixture(3);
    await suspendPublisher(f.ports, "admin@example.test", "acme", "Repeated malware");
    const owner = await f.user("own", { role: "owner" });
    const row = (await f.d1.query("select id, kind from moderation_actions")).rows[0];
    expect(row?.kind).toBe("suspend");
    expect((await f.d1.query("select state from scopes where id = 'scope-acme'")).rows[0]?.state).toBe("held");
    await fileAppeal(f.ports, String(row?.id), owner, "mistake");
    await decideModerationAppeal(f.ports, String(row?.id), "admin@example.test", "upheld");
    expect((await f.d1.query("select state from scopes where id = 'scope-acme'")).rows[0]?.state).toBe("active");
  });

  it("tells the publisher a pack was hidden, with the reason and an appeal link, and lifts the demotion on appeal", async () => {
    const f = await fixture(3);
    await f.d1.query("insert into pack_search (pack_id, name, pitch, category, tags, skills, parts, has_repository, card, updated_at) values ('pack-gcp', '@acme/gcp', 'p', 'cloud', '', '', '', 0, '{}', ?)", [iso(START)]);
    const owner = await f.user("own", { role: "owner" });
    expect(await hidePack(f.ports, { kind: "admin", id: "admin@example.test" }, "@acme/gcp", "Misleading listing")).toEqual({ ok: true, changed: true });
    const mail = f.mail.inbox("own@example.test");
    expect(mail).toHaveLength(1);
    expect(mail[0]?.text).toContain("Misleading listing");
    expect(mail[0]?.text).toMatch(/https:\/\/registry\.test\/appeals\//);
    const id = String((await f.d1.query("select id from moderation_actions")).rows[0]?.id);
    await fileAppeal(f.ports, id, owner, "it is accurate");
    await decideModerationAppeal(f.ports, id, "admin@example.test", "upheld");
    expect((await f.d1.query("select demotion from pack_search where pack_id = 'pack-gcp'")).rows[0]?.demotion).toBeNull();
  });
});

describe("who may file", () => {
  it("refuses a young account and a reporter past ten reports in a day", async () => {
    const f = await fixture(3);
    expect(await f.report(await f.user("kid", { age: 0.5 }), "x")).toMatchObject({ ok: false, reason: "young_account" });
    const busy = await f.user("busy");
    for (let i = 0; i < 10; i++) expect((await f.report(busy, `text ${i}`, "spam")).ok).toBe(true);
    expect(await f.report(busy, "one more", "spam")).toMatchObject({ ok: false, reason: "daily_limit" });
    f.advance(DAY + 1000);
    expect((await f.report(busy, "tomorrow", "spam")).ok).toBe(true);
  });

  it("does not count a blocked reporter's open reports toward a hold", async () => {
    const f = await fixture(3);
    const [a, b, c] = [await f.user("a", { adopts: true }), await f.user("b", { adopts: true }), await f.user("c", { adopts: true })] as const;
    await f.report(a, "1");
    await f.report(b, "2");
    await blockReporter(f.ports, a, "admin@example.test");
    await f.report(c, "3");
    expect(await f.state()).toBe("active");
  });
});

describe("a person takes over what the registry or the publisher did", () => {
  const admin = { kind: "admin" as const, id: "admin@example.test" };

  it("keeps a hold an admin confirmed when a later junk report is dismissed", async () => {
    const f = await fixture(3);
    for (const id of ["a", "b", "c"]) await f.report(await f.user(id, { adopts: true }), `text ${id}`);
    expect(await f.state()).toBe("quarantined");
    await moveVersion(f.ports, admin, { pack: "@acme/gcp", version: "1.0.0", transition: "quarantine", reason: "confirmed malware" });
    const junk = await f.report(await f.user("j"), "junk", "malware");
    if (!junk.ok) throw new Error("not filed");
    await dismissAbuse(f.ports, junk.report.id, admin.id);
    expect(await f.state()).toBe("quarantined");
    expect((await f.d1.query("select trigger, restored_at from moderation_actions order by taken_at, rowid")).rows.map((r) => [r.trigger, r.restored_at !== null])).toEqual([["report_standing", true], ["admin", false]]);
  });

  it("rewrites a publisher's yank to PackServer's, so the publisher cannot lift it, and an upheld appeal brings the publisher's yank back", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    const publisherYank = await transitionVersion(f.ports, "yank", { pack: "@acme/gcp", version: "1.0.0", reason: "broken", security: "cve-1", by: "publisher" });
    expect(publisherYank).toMatchObject({ ok: true, changed: true });
    const filed = await f.report(await f.user("r"), "x");
    if (!filed.ok) throw new Error("not filed");
    expect(await actOnAbuse(f.ports, "admin@example.test", filed.report.id, { action: "yank", reason: "malware" })).toEqual({ ok: true });
    const row = async () => (await f.d1.query("select state, status_reason, status_security from pack_versions where id = 'v1'")).rows[0];
    expect(await row()).toMatchObject({ state: "yanked", status_reason: "Removed by PackServer: malware", status_security: "cve-1" });
    expect(await transitionVersion(f.ports, "unyank", { pack: "@acme/gcp", version: "1.0.0", reason: null, by: "publisher" })).toMatchObject({ ok: false });
    expect(f.mail.inbox("own@example.test").some((m) => m.subject.startsWith("Action taken"))).toBe(true);
    const id = String((await f.d1.query("select id from moderation_actions")).rows[0]?.id);
    await fileAppeal(f.ports, id, owner, "ours");
    await decideModerationAppeal(f.ports, id, "admin@example.test", "upheld");
    expect(await row()).toMatchObject({ state: "yanked", status_reason: "broken", status_security: "cve-1" });
  });
});

describe("closing a copyright case", () => {
  const admin = "admin@example.test";
  const reasonOf = async (f: Awaited<ReturnType<typeof fixture>>) => String((await f.d1.query("select status_reason from pack_versions where id = 'v1'")).rows[0]?.status_reason);

  it.each(["withdrawn", "resolved_for_publisher", "entered_in_error"] as const)("returns the version and tells the publisher when the case closes as %s, even after suit", async (reason) => {
    const f = await fixture(3);
    await f.user("own", { role: "owner" });
    const removed = await removeOnCopyrightNotice(f.ports, admin, { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    if (!removed.ok) throw new Error("not removed");
    const caseId = String((await f.d1.query("select id from dmca_cases")).rows[0]?.id);
    await recordSuit(f.ports, caseId, admin);
    expect(await moveVersion(f.ports, { kind: "admin", id: admin }, { pack: "@acme/gcp", version: "1.0.0", transition: "unquarantine", reason: "x" })).toMatchObject({ ok: false, message: expect.stringContaining(`/admin/moderation/dmca/${caseId}/close`) });
    expect(await closeCopyrightCase(f.ports, caseId, admin, reason)).toEqual({ ok: true });
    expect(await f.state()).toBe("active");
    expect(f.mail.inbox("own@example.test").some((m) => m.subject.startsWith("Copyright case closed"))).toBe(true);
    expect((await f.d1.query("select detail from recent_activity where target = 'version:@acme/gcp@1.0.0' order by at, id")).rows.map((r) => (JSON.parse(String(r.detail)) as { verb: string; reason?: string }).reason)).toContain(reason);
    expect(await closeCopyrightCase(f.ports, caseId, admin, reason)).toMatchObject({ ok: false });
  });

  it("puts an earlier quarantine back when the case closes", async () => {
    const f = await fixture(3);
    await f.d1.query("update pack_versions set state = 'quarantined', status_reason = 'rescan' where id = 'v1'");
    await removeOnCopyrightNotice(f.ports, admin, { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    const caseId = String((await f.d1.query("select id from dmca_cases")).rows[0]?.id);
    await closeCopyrightCase(f.ports, caseId, admin, "withdrawn");
    expect(await f.state()).toBe("quarantined");
    expect(await reasonOf(f)).toBe("rescan");
  });

  it("does not mark an earlier admin quarantine restored when an upheld appeal undid nothing", async () => {
    const f = await fixture(3);
    const owner = await f.user("own", { role: "owner" });
    await moveVersion(f.ports, { kind: "admin", id: admin }, { pack: "@acme/gcp", version: "1.0.0", transition: "quarantine", reason: "Looking" });
    const first = String((await f.d1.query("select id from moderation_actions")).rows[0]?.id);
    await removeOnCopyrightNotice(f.ports, admin, { pack: "@acme/gcp", version: "1.0.0", complainant: "c@claim.test" });
    await fileAppeal(f.ports, first, owner, "fine");
    await decideModerationAppeal(f.ports, first, admin, "upheld");
    expect(await f.state()).toBe("quarantined");
    expect((await f.d1.query("select restored_at from moderation_actions where id = ?", [first])).rows[0]?.restored_at).toBeNull();
  });
});
