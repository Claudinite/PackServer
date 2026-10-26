import { Hono } from "hono";
import { routes as api } from "./api";
import { routes as mfaPolicy } from "./mfa-policy";

export const routes = new Hono();

routes.route("/", api);
routes.route("/", mfaPolicy);
