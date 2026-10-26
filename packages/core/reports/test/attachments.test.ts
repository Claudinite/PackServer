import { describe, expect, it } from "vitest";
import { classifyAttachment, drainNotices, fileReport, loadAttachment, readReport, saveAttachment, setStatus, sweepReports } from "../index.ts";
import { bug, DAY, fixture } from "./helpers.ts";
import { FakeMail } from "@packserver/ports/fakes";

const bytes = (...values: number[]) => new Uint8Array(values);
const png = (size = 64) => {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);

describe("attachment policy", () => {
  it("accepts a PNG inline and a log as text", () => {
    expect(classifyAttachment({ name: "shot.png", bytes: png() })).toEqual({ ok: true, content_type: "image/png", disposition: "inline" });
    expect(classifyAttachment({ name: "run.log", bytes: text("all fine") })).toMatchObject({ ok: true, disposition: "inline" });
  });

  it("limits size at 5 MB", () => {
    expect(classifyAttachment({ name: "a.png", bytes: png(5 * 1024 * 1024) })).toMatchObject({ ok: true });
    expect(classifyAttachment({ name: "a.png", bytes: png(5 * 1024 * 1024 + 1) })).toMatchObject({ ok: false, reason: "too_large" });
    expect(classifyAttachment({ name: "a.png", bytes: new Uint8Array() })).toMatchObject({ ok: false, reason: "empty" });
  });

  it("blocks a secret without echoing it", () => {
    const token = `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vX7zC9eF1hJ3kL5"}`;
    const verdict = classifyAttachment({ name: "run.log", bytes: text(`token=${token}\n`) });
    expect(verdict).toMatchObject({ ok: false, reason: "secret" });
    expect(JSON.stringify(verdict)).not.toContain(token);
    expect(classifyAttachment({ name: "run.log", bytes: text("token=ghp_xxxxxxxxxxxxxxxxxxxx") })).toMatchObject({ ok: true });
  });

  it("serves active content as an opaque download", () => {
    for (const name of ["x.svg", "x.html", "x.xhtml"]) {
      expect(classifyAttachment({ name, bytes: text("<svg><script>alert(1)</script></svg>") })).toEqual({ ok: true, content_type: "application/octet-stream", disposition: "attachment" });
    }
  });

  it("checks an image's bytes, not its name, and refuses what it does not know", () => {
    expect(classifyAttachment({ name: "x.png", bytes: text("<html></html>") })).toMatchObject({ ok: false, reason: "type_mismatch" });
    expect(classifyAttachment({ name: "x.exe", bytes: bytes(1, 2, 3) })).toMatchObject({ ok: false, reason: "unsupported" });
    expect(classifyAttachment({ name: "noext", bytes: text("hi") })).toMatchObject({ ok: false, reason: "unsupported" });
  });
});

describe("attachment storage", () => {
  it("round-trips a multi-chunk file and attaches it to the report once", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const body = png(1_200_000);
    body.fill(7, 100);
    const saved = await saveAttachment(f.ports, { user_id: ann, name: "../../shot.png", bytes: body });
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.attachment.name).toBe("shot.png");

    const result = await fileReport(f.ports, f.pack, ann, bug({ attachment_ids: [saved.attachment.id] }), null);
    if (!result.ok) throw new Error(result.message);
    expect(result.report.attachments.map((a) => a.id)).toEqual([saved.attachment.id]);

    const loaded = await loadAttachment(f.ports, saved.attachment.id);
    expect(loaded?.report_id).toBe(result.report.id);
    expect(Buffer.compare(loaded!.bytes, body)).toBe(0);
    expect((await readReport(f.ports, result.report.id, { kind: "anonymous" }))?.attachments).toHaveLength(1);
    expect(await fileReport(f.ports, f.pack, ann, bug({ attachment_ids: [saved.attachment.id] }), null)).toMatchObject({ ok: false, reason: "attachment_unavailable" });
  });

  it("discards files never attached after a day", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const saved = await saveAttachment(f.ports, { user_id: ann, name: "a.png", bytes: png() });
    if (!saved.ok) throw new Error(saved.message);
    f.advance(DAY - 1000);
    expect((await sweepReports(f.ports)).discarded).toBe(0);
    f.advance(2000);
    expect((await sweepReports(f.ports)).discarded).toBe(1);
    expect(await loadAttachment(f.ports, saved.attachment.id)).toBeNull();
    expect((await f.d1.query("select count(*) as n from report_attachment_chunks")).rows[0]?.n).toBe(0);
  });

  it("caps files waiting to be attached", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    for (let i = 0; i < 10; i += 1) expect(await saveAttachment(f.ports, { user_id: ann, name: `a${i}.png`, bytes: png() })).toMatchObject({ ok: true });
    expect(await saveAttachment(f.ports, { user_id: ann, name: "late.png", bytes: png() })).toMatchObject({ ok: false, reason: "too_many" });
  });
});

describe("notice delivery", () => {
  it("sends queued notices through the mail port and marks them, skipping people with no address", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const maria = await f.user("maria", "maintainer");
    const ghost = "user-ghost";
    await f.d1.query("insert into users (id, handle, created_at) values (?, 'ghost', 'x')", [ghost]);
    const result = await fileReport(f.ports, f.pack, ghost, bug(), null);
    if (!result.ok) throw new Error(result.message);
    await setStatus(f.ports, result.report.id, { kind: "user", id: maria }, { status: "acknowledged" });
    const other = await fileReport(f.ports, f.pack, ann, bug({ title: "other" }), null);
    if (!other.ok) throw new Error(other.message);
    await setStatus(f.ports, other.report.id, { kind: "user", id: maria }, { status: "wont_fix" });

    const mail = new FakeMail();
    expect(await drainNotices(f.ports, { mail, siteOrigin: "https://registry.example", securityAddress: "security@registry.test" })).toEqual({ sent: 1, skipped: 1 });
    expect(mail.inbox("ann@example.test").map((m) => m.subject)).toEqual(["Your report on @acme/gcp is marked won't fix"]);
    expect(await drainNotices(f.ports, { mail, siteOrigin: "https://registry.example", securityAddress: "security@registry.test" })).toEqual({ sent: 0, skipped: 0 });
  });
});

describe("attachment storage allowance", () => {
  const big = (n: number) => png(n);

  it("limits what one account may upload in 24 hours, and frees it afterwards", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const bob = await f.user("bob");
    const chunk = 5 * 1024 * 1024;
    for (let i = 0; i < 5; i += 1) expect(await saveAttachment(f.ports, { user_id: ann, name: `a${i}.png`, bytes: big(chunk) })).toMatchObject({ ok: true });
    const refused = await saveAttachment(f.ports, { user_id: ann, name: "more.png", bytes: big(chunk) });
    expect(refused).toMatchObject({ ok: false, reason: "allowance" });
    expect(await saveAttachment(f.ports, { user_id: bob, name: "b.png", bytes: big(1024) })).toMatchObject({ ok: true });
    f.advance(DAY + 1000);
    expect(await saveAttachment(f.ports, { user_id: ann, name: "later.png", bytes: big(1024) })).toMatchObject({ ok: true });
  }, 60_000);

  it("refuses every upload once the registry holds its ceiling of attachment bytes", async () => {
    const f = await fixture();
    const ann = await f.user("ann");
    const other = await f.user("other");
    // Stand in for many uploaders: the ceiling counts every stored byte, not one account's.
    const rows = Array.from({ length: 100 }, (_, i) => ({
      sql: `insert into report_attachments (id, report_id, uploader_id, name, content_type, disposition, size_bytes, sha256, created_at) values (?, null, '${other}', 'x.png', 'image/png', 'inline', 5242880, 'h', '2020-01-01T00:00:00.000Z')`,
      params: [`fill-${i}`],
    }));
    await f.d1.batch(rows);
    expect(await saveAttachment(f.ports, { user_id: ann, name: "a.png", bytes: png(1024) })).toMatchObject({ ok: false, reason: "storage_full" });
  });
});
