import type { Context } from "hono";
import type { WebEnv } from "../../context";
import { loadWho, type Who } from "../account/data";

export const NO_STORE = "private, no-store";

/** The signed-in person with a handle, or the redirect to sign in that brings them back here. */
export async function signedIn(c: Context<WebEnv>): Promise<Who | Response> {
  const who = await loadWho(c);
  const here = new URL(c.req.url);
  c.header("cache-control", NO_STORE);
  if (!who) return c.redirect(`/signin?next=${encodeURIComponent(here.pathname + here.search)}`, 303);
  if (who.handle === null) return c.redirect(`/signin?step=handle&next=${encodeURIComponent(here.pathname)}`, 303);
  return who;
}
