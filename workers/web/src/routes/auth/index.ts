import { Hono } from "hono";
import { routes as github } from "./github";
import { routes as session } from "./session";
import { routes as passkey } from "./passkey";
import { routes as recovery } from "./recovery";
import { routes as assert } from "./assert";
import { routes as sessions } from "./sessions";
import { routes as recoveryReview } from "./recovery-review";
import { routes as providers } from "./providers";
import { routes as deletion } from "./delete";
import { routes as device } from "./device";

export const routes = new Hono();

routes.route("/", github);
routes.route("/", session);
routes.route("/", passkey);
routes.route("/", recovery);
routes.route("/", assert);
routes.route("/", sessions);
routes.route("/", recoveryReview);
routes.route("/", providers);
routes.route("/", deletion);
routes.route("/", device);
