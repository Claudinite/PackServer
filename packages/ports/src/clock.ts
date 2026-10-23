import type { Clock } from "./ports";

/**
 * A clock that has to be read asynchronously (the test world's clock lives in another Worker).
 * `sync()` moves `now()` to the instant the source reports and is called once per request.
 */
export interface SyncedClock extends Clock {
  sync(): Promise<void>;
}

export const isSyncedClock = (clock: Clock): clock is SyncedClock => typeof (clock as Partial<SyncedClock>).sync === "function";

export async function syncClock(clock: Clock): Promise<void> {
  if (isSyncedClock(clock)) await clock.sync();
}
