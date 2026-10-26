import { Hono } from "hono";
import { routes as api } from "./api";

export const routes = new Hono();

routes.route("/", api);
