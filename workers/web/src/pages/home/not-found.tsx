import type { Context } from "hono";
import { renderPage } from "../../layout";

/** An unknown or private pack, scope or path answers this one page (REQ-PRIV-001). */
export function notFoundPage(c: Context) {
  c.status(404);
  return renderPage(c, {
    title: "Not found · Claudinite Packs",
    children: (
      <>
        <h1>Not found</h1>
        <form class="search" method="get" action="/browse">
          <input type="search" name="q" placeholder="Search packs" aria-label="Search packs" />
          <button class="btn" type="submit">Search</button>
        </form>
        <p class="lede"><a href="/signin">Sign in</a> if you expected to see something private.</p>
      </>
    ),
  });
}
