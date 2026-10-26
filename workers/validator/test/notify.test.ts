import { describe, expect, it } from "vitest";
import type { VersionPromoted } from "../src/notify/message";
import { consumeNotify, sendVersionPublished } from "../src/notify/consume";
import { seedScope, testRuntime } from "./support";

const message: VersionPromoted = { schema: 1, type: "version.promoted", version_id: "v-acme-gcp-1.0.0", pack: "@acme/gcp", version: "1.0.0", run_id: "run1", dedupe: "v-acme-gcp-1.0.0:promoted" };

async function setup(o: { source?: "upload" | "oidc"; claims?: object } = {}) {
  const t = await testRuntime();
  const { db } = t;
  seedScope(db);
  db.exec(`insert into users (id, handle, created_at) values ('u1', 'ada', 'x'), ('u2', 'bob', 'x'), ('u3', 'cy', 'x');
    insert into user_emails (user_id, address, source, created_at) values ('u1', 'ada@example.test', 'github', 'x'), ('u2', 'bob@example.test', 'github', 'x'), ('u3', 'cy@example.test', 'github', 'x');
    insert into scope_members (scope_id, user_id, role, created_at) values ('s-acme', 'u1', 'owner', 'x'), ('s-acme', 'u2', 'owner', 'x'), ('s-acme', 'u3', 'maintainer', 'x');`);
  db.prepare(
    `insert into upload_credentials (id, secret_hash, source, scope_id, pack_name, version, user_id, claims, staging_key, lifetime, issued_at, expires_at)
     values ('c1', 'h', ?, 's-acme', 'gcp', '1.0.0', 'u3', ?, 'k', 'draft', 'x', 'y')`,
  ).run(o.source ?? "upload", o.claims ? JSON.stringify(o.claims) : null);
  db.exec(`insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, status, start_after, created_at, updated_at)
    values ('run1', 'publish', '${o.source ?? "upload"}', 's-acme', 'gcp', '1.0.0', 'user:u3', 'c1', 'k', '${"a".repeat(64)}', 1, 'finished', 'x', 'x', 'x')`);
  return t;
}

describe("the version-published notice", () => {
  it("goes to every owner and not to a maintainer, naming the path, the actor and an https link", async () => {
    const { rt, fakes } = await setup();
    await sendVersionPublished(rt, message);
    expect(fakes.mail.sent.map((m) => m.to).sort()).toEqual(["ada@example.test", "bob@example.test"]);
    const text = fakes.mail.sent[0]!.text;
    expect(fakes.mail.sent[0]!.subject).toBe("@acme/gcp 1.0.0 was published");
    expect(text).toContain("web upload");
    expect(text).toContain("cy");
    expect(text).toContain("https://registry.example/packs/@acme/gcp/versions");
  });

  it("names trusted publishing and the workflow for an OIDC publish", async () => {
    const { rt, fakes } = await setup({ source: "oidc", claims: { repository: "acme/gcp", repository_id: 1, sha: "c".repeat(40), ref: "refs/heads/main", event_name: "push", run_id: 9, job_workflow_ref: "acme/gcp/.github/workflows/publish.yml@refs/heads/main" } });
    await sendVersionPublished(rt, message);
    expect(fakes.mail.sent[0]!.text).toContain("trusted publishing");
    expect(fakes.mail.sent[0]!.text).toContain("acme/gcp/.github/workflows/publish.yml@refs/heads/main");
  });

  it("sends once to each owner however often the message is redelivered", async () => {
    const { rt, fakes } = await setup();
    await sendVersionPublished(rt, message);
    await sendVersionPublished(rt, message);
    await sendVersionPublished(rt, message);
    expect(fakes.mail.sent).toHaveLength(2);
  });

  it("sends again to the owner whose send failed, and only to that one", async () => {
    const { rt, fakes } = await setup();
    const send = fakes.mail.send.bind(fakes.mail);
    let failing = true;
    fakes.mail.send = async (m) => {
      if (failing && m.to === "bob@example.test") throw new Error("mail down");
      return send(m);
    };
    await expect(sendVersionPublished(rt, message)).rejects.toThrow("mail down");
    failing = false;
    await sendVersionPublished(rt, message);
    expect(fakes.mail.sent.map((m) => m.to).sort()).toEqual(["ada@example.test", "bob@example.test"]);
  });
});

describe("the notify consumer", () => {
  const batch = (...bodies: unknown[]) => {
    const settled: string[] = [];
    const messages = bodies.map((body, n) => ({ body, ack: () => void settled.push(`ack${n}`), retry: () => void settled.push(`retry${n}`) }));
    return { batch: { queue: "notify-test", messages } as unknown as MessageBatch, settled };
  };

  it("acknowledges a delivered message, retries a failed one and drops what it cannot read", async () => {
    const { rt, fakes } = await setup();
    const ok = batch(message, { schema: 1, type: "something.else" }, { ...message, schema: 7 }, "junk");
    await consumeNotify(ok.batch, rt);
    expect(ok.settled).toEqual(["ack0", "ack1", "ack2", "ack3"]);
    expect(fakes.mail.sent).toHaveLength(2);

    const failing = batch({ ...message, run_id: "missing", dedupe: "other" });
    await consumeNotify(failing.batch, rt);
    expect(failing.settled).toEqual(["retry0"]);
  });

  it("reads the next schema version too", async () => {
    const { rt, fakes } = await setup();
    const next = batch({ ...message, schema: 2 });
    await consumeNotify(next.batch, rt);
    expect(next.settled).toEqual(["ack0"]);
    expect(fakes.mail.sent).toHaveLength(2);
  });
});
