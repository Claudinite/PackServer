import { emptyRouterState, type RouterState, type TicketKind } from "@packserver/core/alerts";
import type { KV } from "@packserver/ports";

export const ROUTER_KEYS = {
  state: "router/state",
  outbox: "router/outbox",
  acted: (key: string): string => `router/acted/${key}`,
  burningSince: (version: string): string => `router/burning/${version}`,
  pageTest: "router/page-test",
  poll: (name: string): string => `router/poll/${name}`,
} as const;

const STATE_TTL_SECONDS = 8 * 24 * 3600;
const ACTED_TTL_SECONDS = 7 * 24 * 3600;

export interface OutboxItem {
  ticket: TicketKind | "page";
  subject: string;
  text: string;
  to: string;
  queuedAt: number;
}

async function readJson<T>(kv: KV, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * The router's memory in the judge's own namespace. Reads and writes are not atomic: two alerts landing
 * in the same instant can both see the same count, which at worst lets one extra page through.
 */
export function routerStore(kv: KV) {
  return {
    state: async (): Promise<RouterState> => ({ ...emptyRouterState(), ...((await readJson<Partial<RouterState>>(kv, ROUTER_KEYS.state)) ?? {}) }),
    putState: (state: RouterState) => kv.put(ROUTER_KEYS.state, JSON.stringify(state), { ttl_seconds: STATE_TTL_SECONDS }),
    outbox: async (): Promise<OutboxItem[]> => (await readJson<OutboxItem[]>(kv, ROUTER_KEYS.outbox)) ?? [],
    putOutbox: (items: OutboxItem[]) => kv.put(ROUTER_KEYS.outbox, JSON.stringify(items.slice(-50)), { ttl_seconds: 2 * 24 * 3600 }),
    acted: async (key: string): Promise<boolean> => (await kv.get(ROUTER_KEYS.acted(key))) !== null,
    markActed: (key: string) => kv.put(ROUTER_KEYS.acted(key), "1", { ttl_seconds: ACTED_TTL_SECONDS }),
    burningSince: async (version: string): Promise<number | null> => {
      const raw = await kv.get(ROUTER_KEYS.burningSince(version));
      return raw === null ? null : Number(raw);
    },
    putBurningSince: (version: string, at: number) => kv.put(ROUTER_KEYS.burningSince(version), String(at), { ttl_seconds: 24 * 3600 }),
    json: <T>(key: string) => readJson<T>(kv, key),
    putJson: (key: string, value: unknown, ttl = STATE_TTL_SECONDS) => kv.put(key, JSON.stringify(value), { ttl_seconds: ttl }),
  };
}
export type RouterStore = ReturnType<typeof routerStore>;
