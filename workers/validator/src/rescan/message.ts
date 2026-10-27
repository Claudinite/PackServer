import { queueMessage } from "@packserver/schema";
import { z } from "zod";

/** What a rescan puts on the `reindex` queue so the scope's index and signed history are rebuilt with the version's new status. */
export const VersionStatusChanged = queueMessage({
  type: z.literal("version.status_changed"),
  scope: z.string().min(1),
  pack: z.string().min(1),
  version: z.string().min(1),
  status: z.literal("quarantined"),
  reason: z.string().min(1),
});
export type VersionStatusChanged = z.infer<typeof VersionStatusChanged>;
