import { logStubRun } from "@packserver/http";

/** Until the audit writer lands, the batch goes back to the queue so no event is lost to a consumer that does nothing. */
export async function consumeAudit(batch: MessageBatch<unknown>): Promise<void> {
  logStubRun("admin", "consumer.audit");
  batch.retryAll();
}
