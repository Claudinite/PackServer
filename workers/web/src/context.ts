import type { Context } from "hono";
import type { WebRuntime } from "./bindings";

/** What `createApp` puts on every request, so a route module reads its ports without owning the wiring. */
export type WebEnv = { Variables: { runtime: WebRuntime } };

export const runtimeOf = (c: Context<WebEnv>): WebRuntime => c.get("runtime");
