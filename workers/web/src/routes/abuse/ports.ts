import { createAudit } from "@packserver/core/audit";
import type { ModerationPorts } from "@packserver/core/moderation";
import { requestTelemetry } from "@packserver/http";
import type { Context } from "hono";
import { runtimeOf, siteOriginOf, type WebEnv } from "../../context";

/** What moderation needs from this request; signals ride the request's own telemetry, and the audit trail is the request Worker's. */
export function moderationPorts(c: Context<WebEnv>): ModerationPorts {
  const { ports } = runtimeOf(c);
  const audit = ports.queues.AUDIT_QUEUE;
  const reindex = ports.queues.REINDEX_QUEUE;
  if (!audit || !reindex) throw new Error("the audit or reindex queue is not bound");
  const telemetry = requestTelemetry(c);
  return {
    clock: ports.clock,
    rng: ports.rng,
    d1: ports.d1,
    mail: ports.mail,
    reindex,
    audit: createAudit({ clock: ports.clock, rng: ports.rng, queue: audit, d1: ports.d1 }, { ipKey: "" }),
    emit: (signal, attrs) => telemetry.emit(signal, attrs),
    siteOrigin: siteOriginOf(c),
  };
}
