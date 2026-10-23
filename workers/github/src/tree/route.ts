import { createGithubReader, fetchSourceTree } from "@packserver/core/github";
import { TreeFetchRequest } from "@packserver/schema";
import type { Context } from "hono";
import type { GithubRuntime } from "../bindings";

/** Reached only through the validator's service binding: no public route is configured for it. */
export function treeRoute(runtime: GithubRuntime) {
  return async (c: Context): Promise<Response> => {
    const parsed = TreeFetchRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid tree request" }, 400);
    const { secrets, fetch } = runtime.services;
    const credentials = await Promise.all([secrets.appId(), secrets.privateKey()]).catch(() => null);
    if (!credentials) return c.json({ status: "unreachable", retry_after_s: 60 });
    const [appId, privateKey] = credentials;
    const result = await fetchSourceTree(
      (signal) => createGithubReader({ fetch, appId, privateKey, signal, nowMs: () => runtime.ports.clock.now() }),
      parsed.data,
    );
    return c.json(result);
  };
}
