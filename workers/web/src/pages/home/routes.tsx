import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { PackCardList } from "../browse/card";
import { categoryCounts, searchCards, trendingCards } from "../browse/data";
import { titleCase } from "../browse/format";

export const routes = new Hono<WebEnv>();

const RAIL = 5;

routes.get("/", async (c) => {
  const [categories, recent, trending] = await Promise.all([categoryCounts(c), searchCards(c, { sort: "recent", limit: RAIL }), trendingCards(c)]);
  const failed = !categories.ok || !recent.ok;
  if (!trending.ok) console.warn(JSON.stringify({ page: "home", trending: "unavailable", status: trending.status }));
  c.status(failed ? 503 : 200);
  return renderPage(c, {
    title: "Claudinite Packs",
    current: "/",
    children: (
      <>
        <h1>Packs for Claude Code</h1>
        <p class="lede">Claude Code only, for now. Find a pack, adopt it with one command.</p>
        <form class="search" method="get" action="/browse">
          <input type="search" name="q" placeholder="What do you need your agent to do?" aria-label="Search packs" />
          <button class="btn" type="submit">Search</button>
        </form>
        {failed ? (
          <p class="empty">Packs are unavailable right now. <a href="/">Try again</a></p>
        ) : (
          <>
            <ul class="cats">
              {categories.value.filter((r) => r.count > 0).map((r) => (
                <li><a href={`/browse?category=${encodeURIComponent(r.category)}`}>{titleCase(r.category)}</a><span class="n">{r.count}</span></li>
              ))}
            </ul>
            {recent.value.cards.length > 0 ? (
              <section class="section">
                <h2>Recently published</h2>
                <PackCardList cards={recent.value.cards} />
              </section>
            ) : null}
            {trending.ok && trending.value.length > 0 ? (
              <section class="section">
                <h2>Trending</h2>
                <PackCardList cards={trending.value} />
              </section>
            ) : null}
          </>
        )}
        <p class="foot">Agents: connect to <a href="/claude-code"><code>/mcp</code></a> to search from a session.</p>
      </>
    ),
  });
});
