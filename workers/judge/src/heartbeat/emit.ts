import { createHasher, createTelemetry, scrubIp, type Telemetry } from "@packserver/core/telemetry";
import type { Clock, Stats, TelemetryConfig } from "@packserver/ports";

export interface EmitterOptions {
  releaseId: string;
  versionId: string;
  clock: Clock;
  stats: Stats;
  telemetry: TelemetryConfig;
}

/** Domain events from outside a request, written the way every Worker's handlers write them. */
export function signalEmitter(options: EmitterOptions): Telemetry["emit"] {
  const telemetry = createTelemetry({
    worker: "judge",
    releaseId: options.releaseId,
    versionId: options.versionId,
    stats: options.stats,
    clock: options.clock,
    hasher: createHasher(() => options.telemetry.keys(), options.clock, (error) =>
      console.error(JSON.stringify({ event: "telemetry.keys_unavailable", message: error instanceof Error ? scrubIp(error.message) : "unknown" })),
    ),
  });
  return (signal, attrs) => telemetry.emit(signal, attrs);
}
