import type { Context } from "hono";
import type { WebRuntime } from "./bindings";

/** What `createApp` puts on every request, so a route module reads its ports without owning the wiring. */
export type WebEnv = { Variables: { runtime: WebRuntime } };

export const runtimeOf = (c: Context<WebEnv>): WebRuntime => c.get("runtime");

export function cdnOriginOf(c: Context<WebEnv>): string {
  const origin = runtimeOf(c).config.cdnOrigin;
  if (!origin) throw new Error("CDN_ORIGIN is not set for this environment");
  return origin;
}
