import { listAnchoredHeads } from "@packserver/core/audit";
import { Hono } from "hono";
import { runtimeOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

routes.get("/.well-known/audit-heads", async (c) => {
  const heads = await listAnchoredHeads(runtimeOf(c).ports.d1);
  return c.json({ heads }, 200, { "cache-control": "public, max-age=300" });
});
