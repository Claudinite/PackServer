import type { ProofPorts } from "@packserver/core/scopes";
import type { Context } from "hono";
import type { WebEnv } from "../../context";
import { scopePorts } from "../scopes/guard";

/** Notices link to the public host over https whatever scheme the request arrived on. */
export function proofPorts(c: Context<WebEnv>): ProofPorts {
  const { dns, wellKnown, mail, queues } = c.get("runtime").ports;
  const reindex = queues.REINDEX_QUEUE;
  if (!reindex) throw new Error("the reindex queue is not bound");
  return { ...scopePorts(c), dns, wellKnown, mail, reindex, siteOrigin: c.get("runtime").config.siteOrigins[0] };
}
