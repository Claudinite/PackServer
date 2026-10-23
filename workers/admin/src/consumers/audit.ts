import { consumeAuditMessages } from "@packserver/core/audit";
import type { AdminRuntime } from "../bindings";

/** The queue handler: the audit chain's writer lives in core so the test world can run the same code. */
export async function consumeAudit(batch: MessageBatch<unknown>, runtime: AdminRuntime): Promise<void> {
  await consumeAuditMessages(runtime.ports, batch.messages);
}
