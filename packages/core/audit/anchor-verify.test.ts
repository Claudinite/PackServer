import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it, vi } from "vitest";
import { anchorDailyHead, listAnchoredHeads } from "./anchor";
import { createAudit } from "./emit";
import type { AuditEvent } from "./event";
import { ecdsaSigner, headStatement, rawToDer, rekorTransparency } from "./rekor";
import { MemoryAuditBucket, SqliteD1 } from "./testing";
import { analyticsAppendedPoints } from "./points";
import { HEAD_KEY } from "./chain";
import { verifyAuditChain } from "./verify";
import { appendBatch, type ConsumedMessage } from "./writer";

const HOUR = 3_600_000;

function setup() {
  const fakes = createFakePorts({ worker: "admin" });
  const queue = fakes.queues["AUDIT_QUEUE"]!;
  const d1 = new SqliteD1();
  const bucket = new MemoryAuditBucket();
  const audit = createAudit({ clock: fakes.clock, rng: fakes.rng, queue, d1 }, { ipKey: "k" });
  const events = () => (queue as unknown as { messages: AuditEvent[] }).messages;
  let consumed = 0;
  /** Records `n` events and appends them as one batch. */
  const batch = async (n = 2) => {
    for (let i = 0; i < n; i++) await audit({ kind: "system" }, "admin.action", `t${consumed + i}`);
    const from = consumed;
    consumed = events().length;
    await appendBatch(bucket, events().slice(from).map((event, i): ConsumedMessage => ({ messageId: `m${from + i}`, event })));
  };
  const verify = async (points?: string[] | null) => {
    fakes.clock.advance(5 * HOUR);
    return verifyAuditChain({ auditBucket: bucket, d1, stats: fakes.stats, clock: fakes.clock, ...(points !== undefined && { appendedPoints: async () => points }) });
  };
  return { fakes, d1, bucket, batch, verify, events };
}

const reasons = (r: { problems: Array<{ reason: string }> }) => r.problems.map((p) => p.reason);

describe("nightly verifier", () => {
  it("passes an intact chain that matches the copy and reports it", async () => {
    const { batch, verify, fakes } = setup();
    await batch();
    await batch();
    const report = await verify();
    expect(report).toMatchObject({ batches: 2, events: 4, problems: [], reconciledWith: ["recent_activity"] });
    expect(fakes.stats.points.map((p) => p.name)).toEqual(["audit.chain_verified"]);
  });

  it("flags a changed byte, a dropped middle batch, a dropped tail and a rewritten head", async () => {
    const changed = setup();
    await changed.batch(); await changed.batch(); await changed.batch();
    changed.bucket.tamper(changed.bucket.batchKeys()[1]!, { alter: true, offset: 400 });
    expect(reasons(await changed.verify())).toEqual(expect.arrayContaining(["prev_hash"]));

    const middle = setup();
    await middle.batch(); await middle.batch(); await middle.batch();
    middle.bucket.tamper(middle.bucket.batchKeys()[1]!, { drop: true });
    expect(reasons(await middle.verify())).toEqual(expect.arrayContaining(["gap", "prev_hash"]));

    const tail = setup();
    await tail.batch(); await tail.batch();
    tail.bucket.tamper(tail.bucket.batchKeys()[1]!, { drop: true });
    const dropped = await tail.verify();
    expect(reasons(dropped)).toContain("tail");
    expect(tail.fakes.stats.points.filter((p) => p.name === "audit.chain_broken").map((p) => p.blobs[1])).toContain("tail");
    expect(tail.fakes.stats.points.some((p) => p.name === "audit.chain_verified")).toBe(false);
  });

  it("flags batches whose content was swapped into the wrong position", async () => {
    const s = setup();
    await s.batch(); await s.batch();
    const [a, b] = s.bucket.batchKeys() as [string, string];
    const [bodyA, bodyB] = [s.bucket.objects.get(a)!, s.bucket.objects.get(b)!];
    s.bucket.objects.set(a, bodyB);
    s.bucket.objects.set(b, bodyA);
    expect(reasons(await s.verify())).toEqual(expect.arrayContaining(["reordered"]));
  });

  it("names an event list that no longer matches the batch header", async () => {
    const s = setup();
    await s.batch();
    const key = s.bucket.batchKeys()[0]!;
    const lines = s.bucket.objects.get(key)!.split("\n");
    s.bucket.objects.set(key, [lines[0], lines[1], ""].join("\n"));
    expect(reasons(await s.verify())).toContain("event_ids");
  });

  it("flags a chain cut back to an earlier batch after its head was published", async () => {
    const s = setup();
    await s.batch(); await s.batch(); await s.batch();
    const ports = { auditBucket: s.bucket, d1: s.d1, transparency: s.fakes.transparency, clock: s.fakes.clock };
    expect((await anchorDailyHead(ports)).status).toBe("anchored");
    const keys = s.bucket.batchKeys();
    const previous = JSON.parse(s.bucket.objects.get(HEAD_KEY)!) as { seq: number; hash: string; key: string };
    s.bucket.tamper(keys[2]!, { drop: true });
    const { sha256Hex } = await import("@packserver/ports");
    s.bucket.objects.set(HEAD_KEY, JSON.stringify({ ...previous, seq: 1, key: keys[1], hash: await sha256Hex(s.bucket.objects.get(keys[1]!)!) }));
    const report = await s.verify();
    expect(reasons(report)).toEqual(expect.arrayContaining(["anchored_head_missing"]));
    expect(s.fakes.stats.points.some((p) => p.name === "audit.chain_broken" && p.blobs[1] === "anchored_head_missing")).toBe(true);
    expect(s.fakes.stats.points.some((p) => p.name === "audit.chain_verified")).toBe(false);
  });

  it("flags a published head whose batch was rewritten", async () => {
    const s = setup();
    await s.batch(); await s.batch();
    await anchorDailyHead({ auditBucket: s.bucket, d1: s.d1, transparency: s.fakes.transparency, clock: s.fakes.clock });
    s.d1.db.exec("update audit_heads set hash = '" + "0".repeat(64) + "'");
    expect(reasons(await s.verify())).toEqual(["anchored_head_changed"]);
  });

  it("reports an unreadable head pointer instead of throwing", async () => {
    const s = setup();
    await s.batch();
    s.bucket.objects.set(HEAD_KEY, "{not json");
    expect(reasons(await s.verify())).toEqual(["head_corrupt"]);
    s.bucket.objects.set(HEAD_KEY, JSON.stringify({ seq: "x" }));
    expect(reasons(await s.verify())).toEqual(["head_corrupt"]);
    expect(s.fakes.stats.points.filter((p) => p.name === "audit.chain_broken")).toHaveLength(2);
  });

  it("reconciles in both directions against the copy, grouped by day", async () => {
    const missing = setup();
    await missing.batch();
    missing.d1.db.exec("delete from recent_activity where rowid = (select min(rowid) from recent_activity)");
    const gap = await missing.verify();
    expect(gap.problems).toEqual([{ kind: "reconciliation", batch: -1, key: "2026-10-22", reason: "missing_in_copy:recent_activity:1" }]);

    const extra = setup();
    await extra.batch();
    extra.d1.db.exec(
      "insert into recent_activity (id, at, actor_kind, action) values ('evt-forged', '2026-10-22T12:00:00.000Z', 'system', 'admin.action')",
    );
    expect(reasons(await extra.verify())).toEqual(["missing_in_chain:recent_activity:1"]);
  });

  it("leaves events still in flight out of the comparison", async () => {
    const s = setup();
    await s.batch();
    s.d1.db.exec("delete from recent_activity");
    s.fakes.clock.advance(1);
    const report = await verifyAuditChain({ auditBucket: s.bucket, d1: s.d1, stats: s.fakes.stats, clock: s.fakes.clock });
    expect(report.problems).toEqual([]);
  });

  it("reconciles with the appended points when a reader is wired, and says when it is not", async () => {
    const s = setup();
    await s.batch();
    const ids = s.events().map((e) => e.id);
    expect(await s.verify(ids)).toMatchObject({ problems: [], reconciledWith: ["recent_activity", "audit.appended"] });

    const lost = setup();
    await lost.batch();
    const missing = await lost.verify([lost.events()[0]!.id]);
    expect(reasons(missing)).toEqual(["missing_in_points:audit.appended:1"]);

    const stray = setup();
    await stray.batch();
    const extra = await stray.verify([...stray.events().map((e) => e.id), "evt-not-in-chain"]);
    expect(reasons(extra)).toEqual(["missing_in_chain:audit.appended:1"]);

    const failing = setup();
    await failing.batch();
    failing.fakes.clock.advance(5 * HOUR);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const survived = await verifyAuditChain({
      auditBucket: failing.bucket, d1: failing.d1, stats: failing.fakes.stats, clock: failing.fakes.clock,
      appendedPoints: async () => { throw new Error("403"); },
    });
    expect(survived).toMatchObject({ problems: [], reconciledWith: ["recent_activity"] });
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();

    const unwired = setup();
    await unwired.batch();
    expect((await unwired.verify(null)).reconciledWith).toEqual(["recent_activity"]);
  });
});

describe("daily head anchoring", () => {
  function logOver(status = 201) {
    const entries: Array<{ digest: string; signature: string; pem: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://rekor.test/api/v1/log/entries");
      const entry = JSON.parse(String(init?.body)) as {
        kind: string;
        spec: { data: { hash: { value: string } }; signature: { content: string; publicKey: { content: string } } };
      };
      expect(entry.kind).toBe("hashedrekord");
      entries.push({ digest: entry.spec.data.hash.value, signature: entry.spec.signature.content, pem: Buffer.from(entry.spec.signature.publicKey.content, "base64").toString() });
      if (status !== 201) return new Response("no", { status });
      const body = Buffer.from(JSON.stringify({ spec: entry.spec })).toString("base64");
      return Response.json({ uuid: { body, logIndex: 41 + entries.length } }, { status: 201 });
    };
    return { entries, fetchImpl };
  }
  const key = () => ecdsaSigner(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string);

  it("submits the head with a signature that verifies under the key it carries", async () => {
    const { entries, fetchImpl } = logOver();
    const head = { seq: 3, hash: "ab".repeat(32) };
    const result = await rekorTransparency({ signer: await key(), url: "https://rekor.test/" }, fetchImpl).anchor(head);
    expect(result).toEqual({ log_index: 42, anchored_hash: head.hash });
    const [entry] = entries;
    expect(entry!.digest).toBe(createHash("sha256").update(headStatement(head)).digest("hex"));
    expect(createVerify("sha256").update(headStatement(head)).verify(entry!.pem, Buffer.from(entry!.signature, "base64"))).toBe(true);
  });

  it("refuses a log that answers with another digest, a failure status or no entry", async () => {
    const signer = await key();
    const other: typeof fetch = async () =>
      Response.json({ u: { body: Buffer.from(JSON.stringify({ spec: { data: { hash: { value: "00" } } } })).toString("base64"), logIndex: 1 } }, { status: 201 });
    await expect(rekorTransparency({ signer, url: "https://rekor.test" }, other).anchor({ seq: 0, hash: "a".repeat(64) })).rejects.toThrow(/different digest/);
    await expect(rekorTransparency({ signer, url: "https://rekor.test" }, logOver(503).fetchImpl).anchor({ seq: 0, hash: "a".repeat(64) })).rejects.toThrow(/503: no/);
    await expect(rekorTransparency({ signer, url: "https://rekor.test" }, async () => Response.json({}, { status: 201 })).anchor({ seq: 0, hash: "a".repeat(64) })).rejects.toThrow(/without a log entry/);
  });

  it("encodes r||s as DER, padding a high first byte", () => {
    const raw = new Uint8Array(64).fill(1);
    raw[0] = 0x80;
    raw[32] = 0;
    raw[33] = 5;
    const der = rawToDer(raw);
    expect([...der.slice(0, 6)]).toEqual([0x30, der.length - 2, 0x02, 0x21, 0x00, 0x80]);
    expect(der.length).toBe(70);
  });

  it("publishes once a day, writes the row only after the log answered, and serves it newest first", async () => {
    const s = setup();
    await s.batch();
    const { fetchImpl } = logOver();
    const transparency = rekorTransparency({ signer: await key(), url: "https://rekor.test" }, fetchImpl);
    const ports = { auditBucket: s.bucket, d1: s.d1, transparency, clock: s.fakes.clock };

    const down = rekorTransparency({ signer: await key(), url: "https://rekor.test" }, logOver(500).fetchImpl);
    await expect(anchorDailyHead({ ...ports, transparency: down })).rejects.toThrow();
    expect(await listAnchoredHeads(s.d1)).toEqual([]);

    const first = await anchorDailyHead(ports);
    expect(first.status).toBe("anchored");
    expect((await anchorDailyHead(ports)).status).toBe("already_anchored");
    await s.batch();
    s.fakes.clock.advance("1d");
    await anchorDailyHead(ports);
    const heads = await listAnchoredHeads(s.d1);
    expect(heads.map((h) => [h.day, h.seq])).toEqual([["2026-10-23", 1], ["2026-10-22", 0]]);
  });

  it("publishes nothing for a chain with no batch", async () => {
    const s = setup();
    const outcome = await anchorDailyHead({ auditBucket: s.bucket, d1: s.d1, transparency: { anchor: async () => { throw new Error("unexpected"); } }, clock: s.fakes.clock });
    expect(outcome).toEqual({ status: "empty" });
  });
});

describe("analytics engine points reader", () => {
  const config = { accountId: "acc1", dataset: "domain_events_test", token: async () => "tok" };

  it("queries audit.appended since the time given, pages through results and returns the ids", async () => {
    const calls: Array<{ url: string; auth: string | null; sql: string }> = [];
    const full = Array.from({ length: 10_000 }, (_, i) => ({ id: `e${i}` }));
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), sql: String(init?.body) });
      return Response.json({ data: calls.length === 1 ? full : [{ id: "last" }] });
    };
    const ids = await analyticsAppendedPoints(config, fetchImpl)("2026-07-26T00:00:00.000Z");
    expect(ids).toHaveLength(10_001);
    expect(calls[0]).toMatchObject({ url: "https://api.cloudflare.com/client/v4/accounts/acc1/analytics_engine/sql", auth: "Bearer tok" });
    expect(calls[0]!.sql).toContain("index1 = 'audit.appended'");
    expect(calls[0]!.sql).toContain("toDateTime('2026-07-26 00:00:00')");
    expect(calls[1]!.sql).toContain("OFFSET 10000");
  });

  it("fails with the service's answer rather than reporting no points", async () => {
    await expect(analyticsAppendedPoints(config, async () => new Response("bad token", { status: 403 }))("2026-07-26T00:00:00.000Z")).rejects.toThrow(/403: bad token/);
    await expect(analyticsAppendedPoints(config, async () => Response.json({}))("2026-07-26T00:00:00.000Z")).rejects.toThrow(/without data/);
  });

  it("refuses a dataset name that is not an identifier", () => {
    expect(() => analyticsAppendedPoints({ ...config, dataset: "x; drop" })).toThrow(/not a dataset name/);
  });
});
