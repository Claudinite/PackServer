import { createShell, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { WebRuntime } from "./bindings";
import type { WebEnv } from "./context";
import { selfTestChecks } from "./selftest";
import { routes as auth } from "./routes/auth";
import { routes as scopes } from "./routes/scopes";
import { routes as orgs } from "./routes/orgs";
import { routes as tokens } from "./routes/tokens";
import { routes as packs } from "./routes/packs";
import { routes as private_ } from "./routes/private";
import { routes as access } from "./routes/access";
import { routes as trustedPublishers } from "./routes/trusted-publishers";
import { routes as abuse } from "./routes/abuse";
import { routes as apiLeak } from "./routes/api-leak";
import { routes as publishApproval } from "./routes/publish-approval";
import { routes as reportHashMismatch } from "./routes/report-hash-mismatch";
import { routes as wellKnown } from "./routes/well-known";
import { routes as homePage } from "./pages/home";
import { routes as browsePage } from "./pages/browse";
import { routes as profilePage } from "./pages/profile";
import { routes as claudeCodePage } from "./pages/claude-code";
import { routes as rulesPage } from "./pages/rules";
import { routes as pricingPage } from "./pages/pricing";
import { routes as packPage } from "./pages/pack";
import { routes as signinPage } from "./pages/signin";
import { routes as accountPage } from "./pages/account";
import { routes as reviewPage } from "./pages/review";
import { routes as reportPage } from "./pages/report";
import { routes as accessPage } from "./pages/access";
import { routes as dashboardPage } from "./pages/dashboard";
import { routes as validationPage } from "./pages/validation";
import { routes as publishPage } from "./pages/publish";
import { routes as orgSettingsPage } from "./pages/org-settings";
import { routes as githubPage } from "./pages/github";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

/** API routers declare their paths relative to /api; page routers and well-known declare absolute paths. */
export function createApp(runtime: WebRuntime, options: AppOptions = {}): Hono {
  const app = createShell<WebEnv>({
    worker: "web",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
  app.use(async (c, next) => {
    c.set("runtime", runtime);
    await next();
  });
  for (const api of [auth, scopes, orgs, tokens, packs, private_, access, trustedPublishers, abuse, apiLeak, publishApproval, reportHashMismatch]) {
    app.route("/api", api);
  }
  for (const page of [homePage, browsePage, profilePage, claudeCodePage, rulesPage, pricingPage, packPage, signinPage, accountPage, reviewPage, reportPage, accessPage, dashboardPage, validationPage, publishPage, orgSettingsPage, githubPage]) {
    app.route("/", page);
  }
  app.route("/", wellKnown);
  return app as unknown as Hono;
}
