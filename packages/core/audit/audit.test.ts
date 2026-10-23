import { sha256Hex } from "@packserver/ports";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import * as api from "./index";
import { pruneActivity, scopeActivity, userActivity } from "./activity";
import { s3AuditBucket } from "./bucket";
import { GENESIS_HASH, HEAD_KEY, parseBatch } from "./chain";
import { createAudit } from "./emit";
import { AUDIT_ACTIONS, acceptAuditEvent, type AuditEvent } from "./event";
import { MemoryAuditBucket, SqliteD1 } from "./testing";
import { appendBatch, type ConsumedMessage } from "./writer";

const IP = "203.0.113.9";
const TOKEN = "psk_live_0123456789abcdef";

function setup() {
  const fakes = createFakePorts({ worker: "admin" });
  const queue = fakes.queues["AUDIT_QUEUE"]!;
  const d1 = new SqliteD1();
  const audit = createAudit({ clock: fakes.clock, rng: fakes.rng, queue, d1 }, { ipKey: "master-key" });
  const bucket = new MemoryAuditBucket();
  const events = () => (queue as unknown as { messages: AuditEvent[] }).messages;
  const consume = (from: number, to = events().length) =>
    appendBatch(bucket, events().slice(from, to).map((event, i): ConsumedMessage => ({ messageId: `m${from + i}`, event })));
  return { fakes, d1, audit, bucket, events, consume };
}

/** What a verifier does with the stored bytes: each batch must name the hash of the one before. */
async function chainErrors(bucket: MemoryAuditBucket): Promise<string[]> {
  const errors: string[] = [];
  let prev = GENESIS_HASH;
  for (const key of bucket.batchKeys()) {
    const body = bucket.objects.get(key)!;
    try {
      if (parseBatch(body).header.prev_hash !== prev) errors.push(`${key}: prev_hash`);
    } catch {
      errors.push(`${key}: unreadable`);
    }
    prev = await sha256Hex(body);
  }
  const head = JSON.parse(bucket.objects.get(HEAD_KEY) ?? "{}") as { hash?: string };
  if (head.hash !== prev) errors.push("head");
  return errors;
}

describe("IT-AUDIT-001 every sensitive action writes an entry", () => {
  it("queues and copies one entry per action with actor, action, target and time", async () => {
    const { audit, events, d1, fakes } = setup();
    const sensitive = AUDIT_ACTIONS.filter((a) => !a.endsWith(".refused"));
    expect(sensitive).toHaveLength(12);
    for (const action of sensitive) await audit({ kind: "user", id: "u1" }, action, `target:${action}`, { user_id: "u1" });
    expect(events()).toHaveLength(12);
    for (const e of events()) {
      expect(acceptAuditEvent(e).ok).toBe(true);
      expect(e).toMatchObject({ actor: { kind: "user", id: "u1" }, target: `target:${e.action}`, at: new Date(fakes.clock.now()).toISOString() });
    }
    expect(d1.rows("select * from recent_activity")).toHaveLength(12);
  });

  it("exposes no way to edit or delete the record", () => {
    const names = Object.keys(api).filter((n) => /delete|remove|edit|update|redact/i.test(n));
    expect(names).toEqual([]);
  });
});

describe("IT-AUDIT-004 hashed IPs, no secrets", () => {
  it("never lets the address or a secret into a queue message, a batch or a row", async () => {
    const { audit, events, bucket, d1, consume } = setup();
    await audit({ kind: "user", id: "u1" }, "login", undefined, { user_id: "u1", ip: IP });
    await audit({ kind: "user", id: "u1" }, "token.minted", "token:t1", { user_id: "u1", ip: IP, detail: { name: "ci" } });
    await consume(0);
    const held = [JSON.stringify(events()), bucket.everything(), JSON.stringify(d1.rows("select * from recent_activity"))].join("\n");
    expect(held).not.toContain(IP);
    expect(held).not.toContain(TOKEN);
    expect(events()[0]!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rotates the hash daily (IT-TELEM-006, audit half)", async () => {
    const { audit, events, fakes } = setup();
    await audit({ kind: "anonymous" }, "signin.refused", undefined, { ip: IP });
    await audit({ kind: "anonymous" }, "signin.refused", undefined, { ip: IP });
    fakes.clock.advance("1d");
    await audit({ kind: "anonymous" }, "signin.refused", undefined, { ip: IP });
    const [a, b, c] = events().map((e) => e.ip_hash);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("IT-AUDIT-007 refusals are audited with a hashed source", () => {
  it("records each refusal kind with ip_hash", async () => {
    const { audit, events } = setup();
    for (const a of ["signin.refused", "assertion.refused", "token.refused", "oidc.refused"] as const) await audit({ kind: "anonymous" }, a, undefined, { ip: IP });
    expect(events().map((e) => e.action)).toEqual(["signin.refused", "assertion.refused", "token.refused", "oidc.refused"]);
    expect(events().every((e) => e.ip_hash && !JSON.stringify(e).includes(IP))).toBe(true);
  });
});

describe("IT-AUDIT-005 chain half", () => {
  it("chains three batches with the previous hash and the consumed message ids", async () => {
    const { audit, events, bucket, consume } = setup();
    for (let i = 0; i < 6; i++) await audit({ kind: "system" }, "admin.action", `t${i}`);
    await consume(0, 2);
    await consume(2, 4);
    await consume(4, 6);
    const keys = bucket.batchKeys();
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^audit\/2026\/10\/22\/0000000000\.ndjson$/);
    const parsed = keys.map((k) => parseBatch(bucket.objects.get(k)!));
    expect(parsed[0]!.header.prev_hash).toBe(GENESIS_HASH);
    expect(parsed[1]!.header.prev_hash).toBe(await sha256Hex(bucket.objects.get(keys[0]!)!));
    expect(parsed[2]!.header.prev_hash).toBe(await sha256Hex(bucket.objects.get(keys[1]!)!));
    expect(parsed[1]!.header.message_ids).toEqual(["m2", "m3"]);
    expect(parsed.flatMap((p) => p.events.map((e) => e.id)).sort()).toEqual(events().map((e) => e.id).sort());
    expect(await chainErrors(bucket)).toEqual([]);
  });

  it("shows a changed byte in any batch", async () => {
    const { audit, bucket, consume } = setup();
    for (let i = 0; i < 6; i++) await audit({ kind: "system" }, "admin.action", `t${i}`);
    await consume(0, 2);
    await consume(2, 4);
    await consume(4, 6);
    bucket.tamper(bucket.batchKeys()[1]!, 400);
    expect((await chainErrors(bucket)).length).toBeGreaterThan(0);
  });

  it("keeps appending while D1 is down", async () => {
    const { audit, d1, bucket, consume, events } = setup();
    d1.down = true;
    const receipt = await audit({ kind: "user", id: "u1" }, "login", undefined, { user_id: "u1" });
    expect(receipt.copy).toBe("skipped");
    expect(await consume(0)).toMatchObject({ object: "fresh" });
    expect(parseBatch(bucket.objects.get(bucket.batchKeys()[0]!)!).events.map((e) => e.id)).toEqual([events()[0]!.id]);
  });

  it("is idempotent when the queue redelivers", async () => {
    const { audit, events, bucket, consume } = setup();
    for (let i = 0; i < 3; i++) await audit({ kind: "system" }, "admin.action", `t${i}`);
    const first = await consume(0);
    const again = await consume(0);
    expect(again).toMatchObject({ written: [], object: "none" });
    expect(bucket.batchKeys()).toHaveLength(1);
    const twice = await appendBatch(bucket, [{ messageId: "x1", event: events()[0]! }, { messageId: "x2", event: events()[0]! }]);
    expect(twice?.written).toHaveLength(1);
    expect(first?.head.seq).toBe(0);
  });

  it("re-uses the object a crashed attempt already stored", async () => {
    const { audit, bucket, consume } = setup();
    await audit({ kind: "system" }, "admin.action", "a");
    await audit({ kind: "system" }, "admin.action", "b");
    await consume(0, 1);
    const headBefore = bucket.objects.get(HEAD_KEY)!;
    await consume(1, 2);
    bucket.objects.set(HEAD_KEY, headBefore);
    expect(await consume(1, 2)).toMatchObject({ object: "present" });
    expect(bucket.batchKeys()).toHaveLength(2);
    expect(await chainErrors(bucket)).toEqual([]);
  });

  it("refuses to start a second chain when the pointer is gone", async () => {
    const { audit, bucket, consume } = setup();
    await audit({ kind: "system" }, "admin.action", "t");
    await consume(0);
    bucket.objects.delete(HEAD_KEY);
    await expect(consume(0)).rejects.toThrow(/head pointer is missing/);
  });

  it("fails the append when the bucket is down", async () => {
    const { audit, bucket, consume } = setup();
    await audit({ kind: "system" }, "admin.action", "t");
    bucket.down = true;
    await expect(consume(0)).rejects.toThrow();
  });
});

describe("IT-AUDIT-002/003 history and prune", () => {
  it("lists a user's and an org's events at day 89 and prunes at 91", async () => {
    const { audit, d1, fakes } = setup();
    await audit({ kind: "user", id: "u1" }, "login", undefined, { user_id: "u1" });
    fakes.clock.advance("1m");
    await audit({ kind: "user", id: "u1" }, "grant.changed", "g1", { user_id: "u1", scope_id: "org1" });
    await audit({ kind: "user", id: "u2" }, "grant.changed", "g2", { user_id: "u2", scope_id: "org2" });
    fakes.clock.advance("89d");
    expect(await pruneActivity(d1, fakes.clock.now())).toBe(0);
    expect((await userActivity(d1, "u1")).map((r) => r.action)).toEqual(["grant.changed", "login"]);
    expect((await scopeActivity(d1, "org1")).map((r) => r.target)).toEqual(["g1"]);
    fakes.clock.advance("2d");
    expect(await pruneActivity(d1, fakes.clock.now())).toBe(3);
    expect(await userActivity(d1, "u1")).toEqual([]);
  });
});

describe("the S3 writer", () => {
  it("signs object requests against the configured endpoint", async () => {
    const calls: Request[] = [];
    const fetchImpl = (async (req: Request) => {
      calls.push(req);
      return new Response(req.method === "GET" && req.url.includes("list-type") ? "<Key>audit/a</Key><Key>audit/b</Key>" : "ok", { status: req.method === "GET" && !req.url.includes("list-type") ? 404 : 200 });
    }) as unknown as typeof fetch;
    const bucket = s3AuditBucket({ endpoint: "https://acct.r2.cloudflarestorage.com/audit-log/", accessKeyId: "AK", secretAccessKey: "SK" }, fetchImpl);
    await bucket.put("audit/x.ndjson", "{}\n");
    expect(await bucket.get("audit/missing")).toBeNull();
    expect(await bucket.list("audit/", 2)).toEqual(["audit/a", "audit/b"]);
    expect(calls[0]!.url).toBe("https://acct.r2.cloudflarestorage.com/audit-log/audit/x.ndjson");
    expect(calls[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it("throws on a refused write", async () => {
    const bucket = s3AuditBucket({ endpoint: "https://e/b", accessKeyId: "a", secretAccessKey: "s" }, (async () => new Response("no", { status: 403 })) as unknown as typeof fetch);
    await expect(bucket.put("audit/x", "y")).rejects.toThrow(/403/);
  });
});
