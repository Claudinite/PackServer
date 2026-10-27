import { Hono } from "hono";
import { routes as api } from "./api";
import { routes as application } from "./application";
import { routes as dispute } from "./dispute";
import { routes as verification } from "./verification";
import { routes as mfaPolicy } from "./mfa-policy";

export const routes = new Hono();

routes.route("/", api);
routes.route("/", verification);
routes.route("/", application);
routes.route("/", dispute);
routes.route("/", mfaPolicy);
