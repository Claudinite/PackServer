import { Hono } from "hono";
import { routes as manage } from "./manage";

export const routes = new Hono();

routes.route("/", manage);
