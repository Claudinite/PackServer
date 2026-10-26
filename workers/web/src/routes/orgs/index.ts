import { Hono } from "hono";
import { routes as api } from "./api";
import { routes as application } from "./application";
import { routes as verification } from "./verification";

export const routes = new Hono();

routes.route("/", api);
routes.route("/", verification);
routes.route("/", application);
