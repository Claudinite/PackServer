import { queueMessage } from "@packserver/schema";
import { z } from "zod";

/** What a promotion queues for the owners' notice; the consumer deduplicates on `dedupe`. */
export const NOTIFY_SCHEMA = 1;
export const VersionPromoted = queueMessage({
  type: z.literal("version.promoted"),
  version_id: z.string().min(1),
  pack: z.string().min(1),
  version: z.string().min(1),
  run_id: z.string().min(1),
  dedupe: z.string().min(1),
});
export type VersionPromoted = z.infer<typeof VersionPromoted>;
