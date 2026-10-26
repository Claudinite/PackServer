import type { Clock, D1, Rng } from "@packserver/ports";

/**
 * Everything the reports code may touch. There is no GitHub client, no mail port and no bucket here, so a
 * report can neither write to GitHub (REQ-MOD-001) nor send a message itself: notices are rows for the mailer.
 */
export interface ReportPorts {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly d1: D1;
  /** The public origin of the site, for the links notices carry. */
  readonly siteOrigin: string;
}

export const isoNow = (ports: Pick<ReportPorts, "clock">): string => new Date(ports.clock.now()).toISOString();

export type Principal =
  | { kind: "anonymous" }
  | { kind: "user"; id: string }
  | { kind: "registry-security" };
