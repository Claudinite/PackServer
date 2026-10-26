import { CATEGORIES, SEARCH_PARTS } from "@packserver/core/search";
import { SEARCH_SORTS } from "@packserver/schema";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { requestOf } from "../../routes/packs/search";
import { PackCardList } from "./card";
import { searchCards } from "./data";
import { titleCase } from "./format";

export const routes = new Hono<WebEnv>();

export const PAGE_SIZE = 20;

const flagged = (value: string | undefined) => value === "1" || value === "true";

routes.get("/browse", async (c) => {
  const q = c.req.query();
  const loaded = await searchCards(c, { ...(requestOf(c) as object), limit: PAGE_SIZE });
  const offset = Number(q.offset) || 0;
  const next = new URLSearchParams(q);
  next.set("offset", String(offset + PAGE_SIZE));
  c.status(loaded.ok ? 200 : loaded.status);
  return renderPage(c, {
    title: "Browse · Claudinite Packs",
    current: "/browse",
    children: (
      <>
        <h1>Browse</h1>
        <form class="stack mt3" method="get" action="/browse">
          <div class="search">
            <input type="search" name="q" value={q.q ?? ""} placeholder="Search packs" aria-label="Search packs" />
            <button class="btn" type="submit">Search</button>
          </div>
          <div class="filters">
            <label class="field">
              <span class="sr">Category</span>
              <select name="category">
                <option value="">Any category</option>
                {CATEGORIES.map((v) => <option value={v} selected={q.category === v}>{titleCase(v)}</option>)}
              </select>
            </label>
            <label class="field">
              <span class="sr">Part</span>
              <select name="part">
                <option value="">Any part</option>
                {SEARCH_PARTS.map((v) => <option value={v} selected={q.part === v}>{titleCase(v)}</option>)}
              </select>
            </label>
            <label><input type="checkbox" name="verified" value="1" checked={flagged(q.verified)} /> Verified publisher</label>
            <label><input type="checkbox" name="has_repository" value="1" checked={flagged(q.has_repository)} /> Has repository</label>
            <label class="field">
              <span class="muted">Sort</span>
              <select name="sort">
                {SEARCH_SORTS.map((v) => <option value={v} selected={(q.sort ?? "score") === v}>{titleCase(v)}</option>)}
              </select>
            </label>
          </div>
          <details class="more" open={Boolean(q.verified_domains)}>
            <summary>More</summary>
            <label class="field">
              <span class="muted">Verified domains </span>
              <input type="text" name="verified_domains" value={q.verified_domains ?? ""} placeholder="acme.com, example.org" />
            </label>
          </details>
        </form>
        {!loaded.ok ? (
          <p class="empty">{loaded.status === 400 ? "That search is not valid. " : "Search is unavailable right now. "}<a href="/browse">Start again</a></p>
        ) : loaded.value.cards.length === 0 ? (
          <p class="empty">No packs match. <a href="/browse">Clear the filters</a> or try other words.</p>
        ) : (
          <>
            {loaded.value.degraded ? <p class="muted small mt2">Keyword matches only for now.</p> : null}
            <PackCardList cards={loaded.value.cards} />
            {loaded.value.cards.length === PAGE_SIZE ? <p class="foot"><a href={`/browse?${next}`}>More</a></p> : null}
          </>
        )}
      </>
    ),
  });
});
