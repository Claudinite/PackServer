import { describe, expect, it } from "vitest";
import { AdvisoryInput, advisoriesFor, fileReport, hasPublishedAdvisory, linkIssue, listInbox, listIssues, listOwn, publishAdvisory, readReport, setSecurityContact, setStatus, similarIssues, sweepReports } from "../index.ts";
import { bug, DAY, fixture, security } from "./helpers.ts";

const asUser = (id: string) => ({ kind: "user", id }) as const;
const SECURITY = { kind: "registry-security" } as const;

async function filed(f: Awaited<ReturnType<typeof fixture>>, who: string, input: unknown, repo: string | null = null) {
  const result = await fileReport(f.ports, f.pack, who, input as never, repo);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("bug reports", () => {
  it("hand a linked repository's reporter a pre-filled issue and write nothing else", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const result = await filed(f, ann, bug(), "acme/packs");
    expect(result.report).toMatchObject({ route: "github_issue", kind: "bug", status: "open", disclosure: null });
    const url = new URL(result.new_issue_url!);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/acme/packs/issues/new");
    expect(url.searchParams.get("title")).toBe("Guard blocks git push");
    expect(url.searchParams.get("body")).toContain("@acme/gcp@1.0.1");
  });

  it("land in the in-site inbox when no repository is linked", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const owner = await f.user("olga", "owner");
    const result = await filed(f, ann, bug());
    expect(result.new_issue_url).toBeNull();
    expect(result.report.route).toBe("inbox");
    const inbox = await listInbox(f.ports, f.pack, asUser(owner));
    expect(inbox?.reports.map((r) => r.id)).toEqual([result.report.id]);
    expect(await listInbox(f.ports, f.pack, asUser(ann))).toBeNull();
  });

  it("follow the pasted issue through GitHub's state and only that issue", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const { report } = await filed(f, ann, bug(), "acme/packs");
    expect(await linkIssue(f.ports, report.id, ann, "https://evil.example/acme/packs/issues/3")).toMatchObject({ ok: false, reason: "not_an_issue" });
    expect(await linkIssue(f.ports, report.id, ann, "https://github.com/other/repo/issues/3")).toMatchObject({ ok: false, reason: "wrong_repository" });
    expect(await linkIssue(f.ports, report.id, await f.user("bob"), "https://github.com/acme/packs/issues/3")).toMatchObject({ ok: false, reason: "not_found" });
    expect(await linkIssue(f.ports, report.id, ann, "https://github.com/acme/packs/issues/3/")).toMatchObject({ ok: true });

    await f.d1.query(
      "insert into github_issue_states (repository_id, issue_number, repository, html_url, state, source_updated_at, updated_at) values (1, 3, 'acme/packs', 'https://github.com/acme/packs/issues/3', 'closed', 'x', 'x')",
    );
    expect((await readReport(f.ports, report.id, asUser(ann)))?.status).toBe("closed");
  });

  it("reject an unknown version and attachments that are not the reporter's", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    expect(await fileReport(f.ports, f.pack, ann, bug({ version: "9.9.9" }), null)).toMatchObject({ ok: false, reason: "unknown_version" });
    expect(await fileReport(f.ports, f.pack, ann, bug({ attachment_ids: ["nope"] }), null)).toMatchObject({ ok: false, reason: "attachment_unavailable" });
  });
});

describe("similar issues", () => {
  it("lists open bug reports with close titles and never a security report", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const open = await filed(f, ann, bug());
    await filed(f, ann, bug({ title: "Docs typo in the readme" }));
    await filed(f, ann, security({ title: "Guard blocks git push" }));
    const similar = await similarIssues(f.ports, f.pack, "guard blocking git push");
    expect(similar.map((s) => s.id)).toEqual([open.report.id]);
  });
});

describe("status", () => {
  it("is set by maintainers only, and the reporter is told once per change", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const maria = await f.user("maria", "maintainer");
    const outsider = await f.user("zed");
    const { report } = await filed(f, ann, bug());

    expect(await setStatus(f.ports, report.id, asUser(ann), { status: "acknowledged" })).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await setStatus(f.ports, report.id, asUser(outsider), { status: "acknowledged" })).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await setStatus(f.ports, report.id, asUser(maria), { status: "fixed", fixed_in: "9.9.9" })).toMatchObject({ ok: false, reason: "unknown_version" });
    for (const change of [{ status: "acknowledged" }, { status: "fixed", fixed_in: "1.0.2" }, { status: "wont_fix" }, { status: "duplicate" }] as const) {
      expect(await setStatus(f.ports, report.id, asUser(maria), change)).toMatchObject({ ok: true });
    }
    expect(await setStatus(f.ports, report.id, asUser(maria), { status: "duplicate" })).toMatchObject({ ok: false, reason: "no_change" });

    const notices = await f.d1.query("select kind, recipient from report_notices where kind = 'report-status-changed'");
    expect(notices.rows).toHaveLength(4);
    expect(new Set(notices.rows.map((r) => r.recipient))).toEqual(new Set([`user:${ann}`]));
  });
});

describe("scope maintainers", () => {
  it("a scope's maintainer member reads the inbox and sets status, which an owner-only reading of the roles would refuse", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const mia = await f.user("mia", "maintainer");
    const { report } = await filed(f, ann, bug());

    expect(await listInbox(f.ports, f.pack, asUser(mia))).toMatchObject({ reports: [expect.objectContaining({ id: report.id })] });
    expect(await setStatus(f.ports, report.id, asUser(mia), { status: "acknowledged" })).toMatchObject({ ok: true });
  });
});

describe("security reports", () => {
  it("are private to the reporter, maintainers and registry security", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const maria = await f.user("maria", "maintainer");
    const zed = await f.user("zed");
    const { report } = await filed(f, ann, security());
    expect(await setStatus(f.ports, report.id, asUser(zed), { status: "acknowledged" })).toMatchObject({ ok: false, reason: "not_found" });

    for (const who of [asUser(ann), asUser(maria), SECURITY]) expect(await readReport(f.ports, report.id, who)).toMatchObject({ id: report.id, kind: "security" });
    for (const who of [asUser(zed), { kind: "anonymous" } as const]) expect(await readReport(f.ports, report.id, who)).toBeNull();
    expect(await listIssues(f.ports, f.pack)).toEqual([]);
    expect((await listOwn(f.ports, ann)).map((r) => r.id)).toEqual([report.id]);
    expect(await listOwn(f.ports, zed)).toEqual([]);
    expect(report.disclosure).toMatchObject({ days_left: 90, expired: false });
  });

  it("change nothing public until an advisory is published", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const { report } = await filed(f, ann, security());
    await f.d1.query("update reports set status = 'fixed', fixed_in = '1.0.2' where id = ?", [report.id]);
    expect(await advisoriesFor(f.d1, f.pack.id)).toEqual([]);
    expect(await hasPublishedAdvisory(f.d1, f.pack.id, "1.0.1")).toBe(false);

    expect(await publishAdvisory(f.ports, report.id, { summary: "Token leak", versions: ["1.0.0", "1.0.1"], fixed_in: "1.0.2" })).toMatchObject({ ok: true });
    expect((await advisoriesFor(f.d1, f.pack.id, "1.0.1")).map((a) => a.affected_versions)).toEqual([["1.0.0", "1.0.1"]]);
    expect(await advisoriesFor(f.d1, f.pack.id, "1.0.2")).toEqual([]);
    expect(await hasPublishedAdvisory(f.d1, f.pack.id, "1.0.0")).toBe(true);
    expect(await hasPublishedAdvisory(f.d1, f.pack.id, "1.0.2")).toBe(false);
    expect(await publishAdvisory(f.ports, report.id, { summary: "again", versions: ["1.0.0"] })).toMatchObject({ ok: false, reason: "exists" });
  });

  it("cap the named versions' scores and demote the pack, leaving a report that is not yet an advisory alone", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    await f.d1.query("update pack_versions set score = 90, score_rules_version = '2026.10.1' where pack_id = ?", [f.pack.id]);
    await f.d1.query("update pack_versions set score = 30 where pack_id = ? and version = '1.0.0'", [f.pack.id]);
    await f.d1.query(
      "insert into pack_search (pack_id, name, pitch, category, tags, skills, parts, has_repository, card, updated_at) values (?, '@acme/gcp', 'p', 'cloud', '', '', '', 0, '{}', 'x')",
      [f.pack.id],
    );
    const { report } = await filed(f, ann, security());
    const state = async () => ({
      scores: (await f.d1.query("select version, score from pack_versions where pack_id = ? order by version", [f.pack.id])).rows.map((r) => Number(r.score)),
      demotion: (await f.d1.query("select demotion from pack_search where pack_id = ?", [f.pack.id])).rows[0]?.demotion,
    });
    expect(await state()).toEqual({ scores: [30, 90, 90], demotion: null });

    await publishAdvisory(f.ports, report.id, { summary: "Token leak", versions: ["1.0.0", "1.0.1"], fixed_in: "1.0.2" });
    expect(await state()).toEqual({ scores: [30, 40, 90], demotion: "advisory" });
    const breakdown = (await f.d1.query("select score_breakdown from pack_versions where pack_id = ? and version = '1.0.1'", [f.pack.id])).rows[0]?.score_breakdown;
    expect(JSON.parse(String(breakdown))).toEqual({ cap: { reason: "published advisory", max: 40 } });
  });

  it("refuse an advisory for an unknown version or a bug report", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const sec = await filed(f, ann, security());
    const plain = await filed(f, ann, bug());
    expect(await publishAdvisory(f.ports, sec.report.id, { summary: "x", versions: ["7.7.7"] })).toMatchObject({ ok: false, reason: "unknown_version" });
    expect(await publishAdvisory(f.ports, plain.report.id, { summary: "x", versions: ["1.0.0"] })).toMatchObject({ ok: false, reason: "not_security" });
  });

  it("tell registry security alone when the pack has no contact, and the contact too when it has one", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const first = await filed(f, ann, security());
    expect(first.report.route).toBe("registry_security");
    expect((await f.d1.query("select recipient from report_notices")).rows.map((r) => r.recipient)).toEqual(["registry-security"]);

    await setSecurityContact(f.ports, f.pack, "security@acme.test");
    const second = await filed(f, ann, security({ title: "Another" }));
    expect(second.report.route).toBe("security_contact");
    const recipients = (await f.d1.query("select recipient from report_notices order by rowid")).rows.map((r) => r.recipient);
    expect(recipients.slice(1)).toEqual(["registry-security", "address:security@acme.test"]);
  });
});

describe("the disclosure timer", () => {
  it("reminds the owners 7 days before, tells registry security at 90 days, and stops once an advisory exists", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const olga = await f.user("olga", "owner");
    await f.user("maria", "maintainer");
    const first = await filed(f, ann, security());
    const second = await filed(f, ann, security({ title: "Second" }));

    f.advance(82 * DAY);
    expect(await sweepReports(f.ports)).toMatchObject({ reminded: 0, expired: 0 });
    f.advance(1 * DAY);
    expect(await sweepReports(f.ports)).toMatchObject({ reminded: 2, expired: 0 });
    expect(await sweepReports(f.ports)).toMatchObject({ reminded: 0 });
    const reminders = (await f.d1.query("select recipient from report_notices where kind = 'security-report-reminder'")).rows;
    expect(reminders.map((r) => r.recipient)).toEqual([`user:${olga}`, `user:${olga}`]);

    await publishAdvisory(f.ports, first.report.id, { summary: "Disclosed", versions: ["1.0.1"] });
    f.advance(7 * DAY);
    expect(await sweepReports(f.ports)).toMatchObject({ reminded: 0, expired: 1 });
    const expired = (await f.d1.query("select recipient, data from report_notices where data like '%timer_expired%'")).rows;
    expect(expired).toHaveLength(1);
    expect(expired[0]?.recipient).toBe("registry-security");
    expect(String(expired[0]?.data)).toContain(second.report.id);
    expect((await readReport(f.ports, second.report.id, SECURITY))?.disclosure?.expired).toBe(true);
    expect(await hasPublishedAdvisory(f.d1, f.pack.id, "1.0.1")).toBe(true);
  });
});

describe("limits found in review", () => {
  it("accepts an advisory naming 90 versions and refuses 91 at the input", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const names = Array.from({ length: 91 }, (_, i) => `2.${i}.0`);
    await f.d1.batch(names.map((v) => ({ sql: "insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, verified, source_verified) values (?, 'pack-gcp', ?, 'active', ?, 10, 0, 0)", params: [`w-${v}`, v, `s-${v}`] })));
    const { report } = await filed(f, ann, security());
    expect(AdvisoryInput.safeParse({ summary: "x", versions: names }).success).toBe(false);
    const result = await publishAdvisory(f.ports, report.id, AdvisoryInput.parse({ summary: "x", versions: names.slice(0, 90) }));
    expect(result).toMatchObject({ ok: true });
  });

  it("follows an issue whatever the case of the pasted address", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const { report } = await filed(f, ann, bug(), "Acme/Packs");
    const linked = await linkIssue(f.ports, report.id, ann, "https://github.com/ACME/packs/issues/9");
    expect(linked).toMatchObject({ ok: true });
    await f.d1.query(
      "insert into github_issue_states (repository_id, issue_number, repository, html_url, state, source_updated_at, updated_at) values (1, 9, 'Acme/Packs', 'https://github.com/Acme/Packs/issues/9', 'closed', 'x', 'x')",
    );
    expect((await readReport(f.ports, report.id, asUser(ann)))?.status).toBe("closed");
    expect(await linkIssue(f.ports, report.id, ann, "https://github.com/acme/PACKS/issues/9")).toMatchObject({ ok: true });
  });
});
