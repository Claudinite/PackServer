import { PortError } from "@packserver/ports";
import { describe, expect, it, vi } from "vitest";
import { approvalState } from "../src/approval";
import { reviewOutcome } from "../src/review";
import { deliver, resume, waiting } from "../src/resumer";
import type { StepRunner } from "../src/workflow/pipeline";
import { awaitDecision } from "../src/workflow/wait";
import { testRuntime } from "./support";

const retry = { retries: { limit: 2, delay: "1 second" as const } };
const config = { retry, rearm: "7 days" };

/** A step runner that runs each step once and makes each wait for an event throw, as a lapsed timeout does, the given number of times first. */
function waits(lapses: number) {
  const calls: string[] = [];
  let lapsed = 0;
  const step = {
    async do(name: string, a: unknown, b?: () => Promise<unknown>) {
      calls.push(name);
      return (typeof a === "function" ? (a as () => Promise<unknown>) : b!)();
    },
    async waitForEvent(name: string) {
      calls.push(name);
      if (lapsed++ < lapses) throw new Error("timeout");
      return {};
    },
  } as unknown as StepRunner;
  return { step, calls };
}

describe("waiting for a person", () => {
  it("reads the decision before every wait, so one made before the first wait never waits", async () => {
    const { step, calls } = waits(0);
    const outcome = await awaitDecision({ name: "review", event: "review", read: async () => "released" as const, rearmed: vi.fn() }, step, config);
    expect(outcome).toBe("released");
    expect(calls).toEqual(["review-check-0"]);
  });

  it("arms the wait again after a timeout, records the re-arm, and finds a decision made in between", async () => {
    const { step, calls } = waits(2);
    const reads = ["waiting", "waiting", "waiting", "stopped"] as const;
    let n = 0;
    const rearmed = vi.fn();
    const outcome = await awaitDecision({ name: "review", event: "review", read: async () => reads[n++]!, rearmed }, step, config);
    expect(outcome).toBe("stopped");
    expect(rearmed).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      "review-check-0", "review-wait-0", "review-rearmed-0", "review-check-1", "review-wait-1", "review-rearmed-1", "review-check-2", "review-wait-2", "review-check-3",
    ]);
  });
});

async function seeded() {
  const t = await testRuntime();
  t.db.exec(`insert into scopes (id, name, kind, state, created_at) values ('s-acme', 'acme', 'org', 'active', 'x');
    insert into users (id, created_at) values ('u1', 'x');
    insert into validation_runs (id, kind, source, scope_id, pack_name, version, principal, credential_id, staging_key, declared_sha256, size_bytes, status, verdict, start_after, workflow_instance_id, created_at, updated_at)
    values ('run1', 'publish', 'upload', 's-acme', 'gcp', '1.0.0', 'user:u1', 'c1', 'k', '${"e".repeat(64)}', 5, 'finished', 'hold', 'x', 'run1', 'x', 'x')`);
  return t;
}

const decide = (db: Awaited<ReturnType<typeof seeded>>["db"], decision: string) =>
  db.prepare(`insert into review_decisions (run_id, decision, decided_by, decided_at) values ('run1', ?, 'admin@example.test', 'x')`).run(decision);
const appeal = (db: Awaited<ReturnType<typeof seeded>>["db"], state: string) =>
  db.prepare(`insert into review_appeals (run_id, note, submitted_by, submitted_at, state) values ('run1', 'please', 'u1', 'x', ?)`).run(state);

describe("the hold's outcome is the decision row", () => {
  it("waits with no row, releases on an approval, and stops on a rejection or a quarantine", async () => {
    const { rt, db } = await seeded();
    expect(await reviewOutcome(rt.ports.d1, "run1")).toBe("waiting");
    decide(db, "reject");
    expect(await reviewOutcome(rt.ports.d1, "run1")).toBe("stopped");
    db.exec("update review_decisions set decision = 'quarantine_publisher'");
    expect(await reviewOutcome(rt.ports.d1, "run1")).toBe("stopped");
    db.exec("update review_decisions set decision = 'approve'");
    expect(await reviewOutcome(rt.ports.d1, "run1")).toBe("released");
  });

  it("keeps a rejection stopped while its appeal is open or denied, and releases it once upheld", async () => {
    const { rt, db } = await seeded();
    decide(db, "reject");
    appeal(db, "open");
    expect(await reviewOutcome(rt.ports.d1, "run1")).toBe("stopped");
    db.exec("update review_appeals set state = 'denied'");
    expect(await reviewOutcome(rt.ports.d1, "run1")).toBe("stopped");
    db.exec("update review_appeals set state = 'upheld'");
    expect(await reviewOutcome(rt.ports.d1, "run1")).toBe("released");
  });
});

describe("the resumer applies a decision no instance took", () => {
  const instances = (fakes: Awaited<ReturnType<typeof seeded>>["fakes"]) => [...fakes.workflows.VALIDATE_PACK!.instances.keys()];

  it("wakes the instance that still takes events and marks the row taken", async () => {
    const { rt, db, fakes } = await seeded();
    await fakes.workflows.VALIDATE_PACK!.create({ id: "run1", params: {} });
    decide(db, "approve");
    expect(await waiting(rt)).toEqual([{ run_id: "run1", source: "review" }]);
    expect(await resume(rt)).toEqual([{ run_id: "run1", source: "review", delivered: "event" }]);
    expect(fakes.workflows.VALIDATE_PACK!.events).toEqual([{ id: "run1", type: "review", payload: { run_id: "run1" } }]);
    expect(await waiting(rt)).toEqual([]);
  });

  it("starts the steps after the verdict in a new instance when none is left to take the event", async () => {
    const { rt, db, fakes } = await seeded();
    decide(db, "approve");
    expect(await resume(rt, "run1")).toEqual([{ run_id: "run1", source: "review", delivered: "instance" }]);
    expect(instances(fakes)).toHaveLength(1);
    expect(fakes.workflows.VALIDATE_PACK!.instances.get(instances(fakes)[0]!)?.params).toEqual({ run_id: "run1", resume: true });
    expect(await waiting(rt)).toEqual([]);
  });

  it("does the same when the instance is gone and refuses the event", async () => {
    const { rt, db, fakes } = await seeded();
    await fakes.workflows.VALIDATE_PACK!.create({ id: "run1", params: {} });
    vi.spyOn(fakes.workflows.VALIDATE_PACK!, "sendEvent").mockRejectedValue(new PortError("not_found", "finished"));
    decide(db, "approve");
    expect(await resume(rt)).toMatchObject([{ delivered: "instance" }]);
  });

  it("starts nothing for a rejection that stands or a denied appeal, and marks them taken", async () => {
    const { rt, db, fakes } = await seeded();
    decide(db, "reject");
    appeal(db, "denied");
    expect(await resume(rt)).toEqual([{ run_id: "run1", source: "review", delivered: "nothing" }]);
    expect(instances(fakes)).toEqual([]);
    expect(await waiting(rt)).toEqual([]);
  });

  it("resumes an upheld appeal at promotion, once", async () => {
    const { rt, db, fakes } = await seeded();
    decide(db, "reject");
    db.exec("update review_decisions set event_sent_at = 'x'");
    appeal(db, "upheld");
    expect(await resume(rt)).toEqual([{ run_id: "run1", source: "appeal", delivered: "instance" }]);
    expect(await resume(rt)).toEqual([]);
    expect(instances(fakes)).toHaveLength(1);
  });

  it("wakes a run waiting for an owner only once an owner has approved", async () => {
    const { rt, db, fakes } = await seeded();
    await fakes.workflows.VALIDATE_PACK!.create({ id: "run1", params: {} });
    db.exec(`insert into run_approvals (run_id, reasons, sheet, requested_at) values ('run1', '["verified-publisher"]', '{}', 'x')`);
    expect(await waiting(rt)).toEqual([]);
    expect(await approvalState(rt.ports.d1, "run1")).toBe("waiting");
    db.exec("update run_approvals set approved_by = 'u1', approved_at = 'y'");
    expect(await approvalState(rt.ports.d1, "run1")).toBe("approved");
    expect(await resume(rt)).toEqual([{ run_id: "run1", source: "approval", delivered: "event" }]);
    expect(fakes.workflows.VALIDATE_PACK!.events[0]).toMatchObject({ type: "approval" });
  });

  it("delivers one row without sweeping the others", async () => {
    const { rt, db } = await seeded();
    decide(db, "approve");
    expect(await deliver(rt, { run_id: "run1", source: "review" })).toBe("instance");
  });
});
