import { Hono } from "hono";
import { routes as view } from "./view";
import { routes as verify } from "./verify";
import { routes as search } from "./search";
import { routes as contents } from "./contents";
import { routes as stars } from "./stars";
import { routes as reviews } from "./reviews";
import { routes as reports } from "./reports";
import { routes as comments } from "./comments";
import { routes as lifecycle } from "./lifecycle";

export const routes = new Hono();

routes.route("/", view);
routes.route("/", verify);
routes.route("/", search);
routes.route("/", contents);
routes.route("/", stars);
routes.route("/", reviews);
routes.route("/", reports);
routes.route("/", comments);
routes.route("/", lifecycle);
