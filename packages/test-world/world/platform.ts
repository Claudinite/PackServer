import type { Driver } from "../drivers/driver";

export interface Answer {
  status: number;
  release: string;
}

/**
 * Harness-level observations, not product vocabulary: which Workers answer and as which release.
 * They exist so `_smoke` can prove a driver reaches the system; area scenarios never need them.
 */
export function createPlatform(driver: Driver) {
  return {
    workers: (): string[] => [...driver.surfaces],
    /** What each reachable Worker says to a path nothing serves. */
    async unknownPath(): Promise<Record<string, Answer>> {
      const out: Record<string, Answer> = {};
      for (const surface of driver.surfaces) {
        const res = await driver.http.request({ surface, method: "GET", path: "/no/such/path" });
        out[surface] = { status: res.status, release: res.headers.get("x-packserver-version") ?? "" };
      }
      return out;
    },
    capabilities: (): string[] => [...driver.capabilities].sort(),
  };
}
