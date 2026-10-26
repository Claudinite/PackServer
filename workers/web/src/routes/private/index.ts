import { Hono } from "hono";
import { routes as grants } from "./grants";
import { routes as read } from "./read";

export const routes = new Hono();

routes.route("/", read);
routes.route("/", grants);
