import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { handleControl } from "../control";

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const EPOCH = Date.UTC(2026, 0, 15, 10, 0, 0);

function parseDuration(text: string): number {
  const parts = [...text.matchAll(/(\d+)(ms|s|m|h|d)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== text) throw new Error(`not a duration: ${text}`);
  return parts.reduce((total, p) => total + Number(p[1]) * (UNITS[p[2] as string] as number), 0);
}

/** The one instant every Worker reads; durable so a recycled isolate does not move time. */
export class ClockState extends DurableObject {
  async now(): Promise<number> {
    return (await this.ctx.storage.get<number>("ms")) ?? EPOCH;
  }
  async set(ms: number): Promise<number> {
    await this.ctx.storage.put("ms", ms);
    return ms;
  }
  async advance(by: string): Promise<number> {
    return this.set((await this.now()) + parseDuration(by));
  }
}

interface Env {
  CLOCK_STATE: DurableObjectNamespace<ClockState>;
}

/** Stands in for the system clock: `now()` over RPC, steered by the test process. Moving it fires nothing. */
export default class FakeClock extends WorkerEntrypoint<Env> {
  private get state() {
    return this.env.CLOCK_STATE.getByName("clock");
  }
  now() {
    return this.state.now();
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      now: () => this.state.now(),
      set: ({ iso }: { iso: string }) => {
        const ms = Date.parse(iso);
        if (Number.isNaN(ms)) throw new Error(`not an instant: ${iso}`);
        return this.state.set(ms);
      },
      advance: ({ by }: { by: string }) => this.state.advance(by),
      reset: () => this.state.set(EPOCH),
    });
  }
}
