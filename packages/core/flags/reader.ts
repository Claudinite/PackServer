import type { Clock, D1 } from "@packserver/ports";
import { FLAG_DEFS, flagDef, validFlagValue, type FlagValue } from "./defs.ts";
import { verifyFlagMac } from "./mac.ts";
import { loadFlagRows } from "./store.ts";

export const FLAG_TTL_MS = 60_000;

/** Why a flag reads as its compiled default. */
export type FlagSource = "stored" | "default" | "unverified" | "invalid";

export interface FlagSnapshot {
  get(key: string): FlagValue;
  /** Where the value came from, so a switch that is not engaged can be told from one that is off. */
  source(key: string): FlagSource;
  /** When the table was last read successfully. */
  readonly readAt: number | null;
}

export interface FlagCache {
  read(ports: { d1: D1; clock: Clock }, macSecret?: string | null): Promise<FlagSnapshot>;
  /** The next read goes to the table; a writer calls it so its own change is seen at once. */
  invalidate(): void;
}

/**
 * One of these lives at module scope in each Worker, so the table is read once per isolate per
 * 60 s. A security flag counts only when its MAC verifies under the key the reader holds; a reader
 * without the key sees the compiled default. A snapshot is reused only by a reader that holds the key
 * exactly when the one that built it did, so a keyless read cannot leave defaults for a keyed one.
 * A failed read keeps what was last read.
 */
export function createFlagCache(ttlMs = FLAG_TTL_MS): FlagCache {
  let snapshot: FlagSnapshot | undefined;
  let fetchedAt = -Infinity;
  let keyed = false;
  let inflight: { keyed: boolean; done: Promise<void> } | undefined;

  const build = async (d1: D1, macSecret: string | null, at: number): Promise<FlagSnapshot> => {
    const values = new Map<string, { value: FlagValue; source: FlagSource }>();
    for (const row of await loadFlagRows(d1)) {
      const def = flagDef(row.key);
      if (!def) continue;
      let value: FlagValue;
      try {
        value = JSON.parse(row.value) as FlagValue;
      } catch {
        values.set(row.key, { value: def.default, source: "invalid" });
        continue;
      }
      if (!validFlagValue(def, value)) values.set(row.key, { value: def.default, source: "invalid" });
      else if (def.security && !(macSecret && (await verifyFlagMac(macSecret, row)))) values.set(row.key, { value: def.default, source: "unverified" });
      else values.set(row.key, { value, source: "stored" });
    }
    return {
      readAt: at,
      get: (key) => values.get(key)?.value ?? flagDef(key)?.default ?? null,
      source: (key) => values.get(key)?.source ?? "default",
    };
  };

  const fallback: FlagSnapshot = {
    readAt: null,
    get: (key) => FLAG_DEFS.find((d) => d.key === key)?.default ?? null,
    source: () => "default",
  };

  return {
    invalidate() {
      fetchedAt = -Infinity;
    },
    async read(ports, macSecret = null) {
      const now = ports.clock.now();
      const wantKeyed = Boolean(macSecret);
      if (snapshot && keyed === wantKeyed && now - fetchedAt < ttlMs) return snapshot;
      if (inflight?.keyed !== wantKeyed) {
        const done = build(ports.d1, macSecret, now)
          .then((built) => {
            snapshot = built;
            keyed = wantKeyed;
            fetchedAt = now;
          })
          .catch((error: unknown) => {
            console.log(JSON.stringify({ event: "flags.read_failed", reason: String(error) }));
          })
          .finally(() => {
            if (inflight?.done === done) inflight = undefined;
          });
        inflight = { keyed: wantKeyed, done };
      }
      await inflight!.done;
      return snapshot ?? fallback;
    },
  };
}
