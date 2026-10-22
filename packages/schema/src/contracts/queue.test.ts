import { describe, expect, it } from "vitest";
import { z } from "zod";
import { acceptQueueMessage, queueMessage } from "./queue";

const Notify = queueMessage({ version_id: z.string(), event: z.literal("promoted") });
const msg = (schema: number) => ({ schema, version_id: "v1", event: "promoted" });

describe("queue envelope n / n+1", () => {
  it("accepts n and n+1", () => {
    expect(acceptQueueMessage(3, Notify, msg(3)).ok).toBe(true);
    expect(acceptQueueMessage(3, Notify, msg(4)).ok).toBe(true);
  });
  it("refuses n-1 and n+2 as unsupported, naming the schema", () => {
    expect(acceptQueueMessage(3, Notify, msg(2))).toEqual({ ok: false, reason: "schema.unsupported", schema: 2 });
    expect(acceptQueueMessage(3, Notify, msg(5))).toEqual({ ok: false, reason: "schema.unsupported", schema: 5 });
  });
  it("refuses a message without a schema number, or with a bad payload, as malformed", () => {
    expect(acceptQueueMessage(3, Notify, { version_id: "v1", event: "promoted" }).ok).toBe(false);
    expect(acceptQueueMessage(3, Notify, { schema: "3" })).toEqual({ ok: false, reason: "malformed" });
    expect(acceptQueueMessage(3, Notify, { schema: 3, version_id: 1 })).toMatchObject({ ok: false, reason: "malformed" });
    expect(acceptQueueMessage(3, Notify, null).ok).toBe(false);
  });
  it("refuses a n+2 message even if its payload no longer parses", () => {
    expect(acceptQueueMessage(3, Notify, { schema: 5, other: 1 })).toMatchObject({ reason: "schema.unsupported" });
  });
});
