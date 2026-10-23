import { auditHeadsResponse } from "@packserver/core/audit";
import { Hono } from "hono";
import { runtimeOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

routes.get("/.well-known/audit-heads", (c) => auditHeadsResponse(runtimeOf(c).ports.d1));
