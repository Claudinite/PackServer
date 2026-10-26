import { Hono } from "hono";
import { routes as read } from "./read";

export const routes = new Hono();

routes.route("/", read);
