import { Hono } from "hono";
import { routes as auditHeads } from "./audit-heads";

export const routes = new Hono();

routes.route("/", auditHeads);
