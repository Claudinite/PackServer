import type { Clock, D1, Mail, Queue, Rng } from "@packserver/ports";
import type { Audit } from "../audit/index.ts";
import type { SignalAttrs, SignalName } from "../telemetry/index.ts";

/**
 * Everything moderation touches. There is no GitHub client here: moderation never writes to GitHub, and a copyright
 * notice has no GitHub side. Signals go out through `emit`, which a Worker backs with its telemetry.
 */
export interface ModerationPorts {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly d1: D1;
  readonly mail: Mail;
  /** The `reindex` queue: a status change re-signs the scope's index. */
  readonly reindex: Queue;
  readonly audit: Audit;
  readonly emit: (signal: SignalName, attrs: SignalAttrs) => void;
  /** The public origin notices link to. */
  readonly siteOrigin: string;
}

export const isoOf = (ms: number): string => new Date(ms).toISOString();
export const nowIso = (ports: Pick<ModerationPorts, "clock">): string => isoOf(ports.clock.now());

/** Notices link to the public host over https whatever scheme the request arrived on. */
export const publicUrl = (ports: Pick<ModerationPorts, "siteOrigin">, path: string): string => `https://${new URL(ports.siteOrigin).host}${path}`;
