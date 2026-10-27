import type { StepConfig, StepRunner } from "./pipeline";

export interface WaitConfig {
  retry: StepConfig;
  /** How long one wait for an event lasts before it is armed again; a wait that lapses decides nothing. */
  rearm: string;
}

export interface Awaited<S extends string> {
  /** Names the steps, so one instance can wait for different people in turn. */
  name: string;
  /** The event type that wakes the wait. */
  event: string;
  /** Reads the decision from the registry database; anything but `waiting` ends the wait. */
  read(): Promise<S | "waiting">;
  rearmed(): void;
}

/**
 * Waits for a person in a loop. The database is read before every wait, so a decision made before the
 * instance armed it, or while none was waiting, is never missed, and the event only wakes the loop.
 * `waitForEvent` throws when its timeout passes; that arms the next one.
 */
export async function awaitDecision<S extends string>(waiting: Awaited<S>, step: StepRunner, config: WaitConfig): Promise<Exclude<S, "waiting">> {
  for (let n = 0; ; n++) {
    const state = await step.do(`${waiting.name}-check-${n}`, config.retry, async () => ({ state: await waiting.read() }));
    if (state.state !== "waiting") return state.state as Exclude<S, "waiting">;
    try {
      await step.waitForEvent(`${waiting.name}-wait-${n}`, { type: waiting.event, timeout: config.rearm });
    } catch {
      await step.do(`${waiting.name}-rearmed-${n}`, config.retry, async () => {
        waiting.rearmed();
        return { rearmed: true };
      });
    }
  }
}
