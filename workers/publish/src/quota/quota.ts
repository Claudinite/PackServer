import { DO_RPC_SCHEMA_VERSION, type QuotaRpc } from "@packserver/schema";
import type { DoStorage } from "../do-storage";

/** A counter outlives the UTC day it counts by a margin, then goes; the key names the day, so a stale counter is never read again. */
export const COUNTER_LIFETIME_MS = 26 * 3_600_000;

/** The Durable Object name of the counter for one `(kind, principal, day)`. */
export const quotaName = (kind: string, principal: string, day: string): string => `${kind}|${principal}|${day}`;

/** One counter per Durable Object, so check-and-increment is a single uninterrupted call and the cap is exact. */
export class QuotaCounter implements QuotaRpc {
  constructor(
    private readonly storage: DoStorage,
    private readonly now: () => number,
  ) {}

  async ping() {
    return { schema_version: DO_RPC_SCHEMA_VERSION, ok: true as const };
  }

  private async claim(key: string): Promise<void> {
    const held = await this.storage.get<string>("key");
    if (held === undefined) await this.storage.put("key", key);
    else if (held !== key) throw new Error("this counter belongs to another key");
  }

  async consume(request: Parameters<QuotaRpc["consume"]>[0]) {
    await this.claim(quotaName(request.kind, request.principal, request.day));
    const count = (await this.storage.get<number>("count")) ?? 0;
    if (count >= request.cap) return { schema_version: DO_RPC_SCHEMA_VERSION, allowed: false, count, cap: request.cap };
    await this.storage.put("count", count + 1);
    if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(this.now() + COUNTER_LIFETIME_MS);
    return { schema_version: DO_RPC_SCHEMA_VERSION, allowed: true, count: count + 1, cap: request.cap };
  }

  async peek(request: Parameters<QuotaRpc["peek"]>[0]) {
    await this.claim(quotaName(request.kind, request.principal, request.day));
    return { schema_version: DO_RPC_SCHEMA_VERSION, count: (await this.storage.get<number>("count")) ?? 0 };
  }
}
