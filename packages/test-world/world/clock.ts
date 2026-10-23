import type { Driver } from "../drivers/driver";
import { EPOCH } from "../fakes/compose";
import { InfrastructureError } from "./errors";

const DURATION = /^(\d+(ms|s|m|h|d))+$/;

export interface Clock {
  advance(duration: string): Promise<void>;
  set(iso: string): Promise<void>;
  now(): Promise<Date>;
}

/** Time is moved, never waited for: the instant lives in the fake-clock Worker every Worker reads. */
export function createClock(driver: Driver): Clock {
  const fake = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no clock: time cannot be moved on a deployment`);
    return driver.fakes.clock;
  };
  return {
    async advance(duration) {
      if (!DURATION.test(duration)) throw new InfrastructureError(`not a duration: ${duration} (use e.g. 24h1m)`);
      await fake().call("advance", { by: duration });
    },
    async set(iso) {
      await fake().call("set", { iso });
    },
    async now() {
      return new Date(await fake().call<number>("now"));
    },
  };
}

export { EPOCH };
