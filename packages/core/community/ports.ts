import type { Clock, D1, Rng } from "@packserver/ports";

export interface CommunityPorts {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly d1: D1;
}

export const isoOf = (ms: number): string => new Date(ms).toISOString();
export const nowMs = (ports: Pick<CommunityPorts, "clock">): number => ports.clock.now();
