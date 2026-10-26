import { SearchRequest, SearchResponse } from "@packserver/schema";
import type { Context } from "hono";
import type { WebEnv } from "../../context";
import { ask } from "../../routes/packs/search";

export type Card = ReturnType<typeof SearchResponse.parse>["cards"][number];

export type Loaded<T> = { ok: true; value: T } | { ok: false; status: 400 | 503 };

const failure = (answer: Response): { ok: false; status: 400 | 503 } => ({ ok: false, status: answer.status === 400 ? 400 : 503 });

/** One search in mcp, the same call `/api/search` makes. A failed fetch is a failed load, never an empty list. */
export async function searchCards(c: Context<WebEnv>, request: unknown): Promise<Loaded<{ cards: Card[]; degraded: boolean }>> {
  const parsed = SearchRequest.safeParse(request);
  if (!parsed.success) return { ok: false, status: 400 };
  const answer = await ask(c, "/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) });
  if (answer instanceof Response) return failure(answer);
  const body = SearchResponse.safeParse(answer.json);
  return body.success ? { ok: true, value: body.data } : { ok: false, status: 503 };
}

export async function trendingCards(c: Context<WebEnv>): Promise<Loaded<Card[]>> {
  const answer = await ask(c, "/trending");
  if (answer instanceof Response) return failure(answer);
  const body = SearchResponse.shape.cards.safeParse((answer.json as { cards?: unknown } | undefined)?.cards);
  return body.success ? { ok: true, value: body.data } : { ok: false, status: 503 };
}

export interface CategoryCount {
  category: string;
  count: number;
}

export async function categoryCounts(c: Context<WebEnv>): Promise<Loaded<CategoryCount[]>> {
  const answer = await ask(c, "/categories");
  if (answer instanceof Response) return failure(answer);
  const list = (answer.json as { categories?: unknown } | undefined)?.categories;
  const valid = Array.isArray(list) && list.every((r) => typeof r?.category === "string" && Number.isInteger(r?.count));
  return valid ? { ok: true, value: list as CategoryCount[] } : { ok: false, status: 503 };
}
