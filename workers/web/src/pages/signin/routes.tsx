import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";

export const routes = new Hono<WebEnv>();

routes.get("/signin", (c) =>
  renderPage(c, {
    title: "Sign in · Claudinite Packs",
    children: (
      <>
        <h1>Sign in</h1>
        <p class="lede">Browsing and searching need no account.</p>
        <div class="stack mt3">
          <button class="btn" type="button" disabled>Sign in with a passkey</button>
          <button class="btn" type="button" disabled>Continue with GitHub</button>
        </div>
      </>
    ),
  }),
);
