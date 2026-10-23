import { stubModule } from "../errors";

/** The fake stats sink: signals by the names the telemetry catalogue gives. */
export interface TelemetryModule {
  telemetry: { recorded(): Promise<Array<{ name: string; attrs: Record<string, unknown> }>> };
}

export const createTelemetry = (): TelemetryModule => ({ telemetry: stubModule("telemetry") });
