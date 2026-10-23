import type { Stats, StatsPoint } from "@packserver/ports";
import { DOWNLOAD_BLOBS } from "./recorder";
import { REQUEST_BLOBS, REQUEST_DOUBLES, UNKNOWN_DOUBLE } from "./event";
import { datasetFor, type AnalyticsDataset } from "./signals";

export interface Recorded {
  signal: string;
  dataset: AnalyticsDataset;
  index: string;
  /** The point's fields by name: the wide event's columns, the download columns, or a domain event's attributes. */
  fields: Record<string, string | number | boolean>;
  point: StatsPoint;
}

function decode(point: StatsPoint): Recorded {
  const fields: Record<string, string | number | boolean> = {};
  if (point.name === "http.request") {
    REQUEST_BLOBS.forEach((k, i) => point.blobs[i] && (fields[k] = point.blobs[i] as string));
    REQUEST_DOUBLES.forEach((k, i) => {
      const v = point.doubles[i];
      if (v !== undefined && v !== UNKNOWN_DOUBLE) fields[k] = k === "version_override" || k === "is_synthetic" ? v === 1 : v;
    });
  } else if (point.name === "download.served") {
    DOWNLOAD_BLOBS.forEach((k, i) => point.blobs[i] && (fields[k] = point.blobs[i] as string));
    if ((point.doubles[0] ?? UNKNOWN_DOUBLE) !== UNKNOWN_DOUBLE) fields.bytes = point.doubles[0] as number;
  } else {
    Object.assign(fields, JSON.parse(point.blobs[3] ?? "{}"));
  }
  return { signal: point.name, dataset: datasetFor(point.name), index: point.index ?? point.name, fields, point };
}

/** The Stats port and console for tests: backs `world.telemetry` and the `toHaveRecorded` matcher. */
export class TelemetrySink implements Stats {
  readonly points: StatsPoint[] = [];
  readonly lines: string[] = [];
  write(point: StatsPoint): void {
    this.points.push(point);
  }
  log = (line: string): void => {
    this.lines.push(line);
  };
  recorded(signal?: string): Recorded[] {
    return this.points.map(decode).filter((r) => signal === undefined || r.signal === signal);
  }
  /** The console lines as parsed objects. */
  logged(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  /** Every byte telemetry stored or logged, for scans like "this address appears nowhere". */
  everything(): string {
    return JSON.stringify(this.points) + this.lines.join("\n");
  }
  clear(): void {
    this.points.length = 0;
    this.lines.length = 0;
  }
}

const matches = (fields: Recorded["fields"], match: Record<string, unknown>): boolean =>
  Object.entries(match).every(([k, v]) => (v === undefined ? !(k in fields) : fields[k] === v));

/** A field set to `undefined` in `match` must be absent from the record. */
export function toHaveRecorded(received: TelemetrySink, signal: string, match: Record<string, unknown> = {}) {
  const found = received.recorded(signal);
  const pass = found.some((r) => matches(r.fields, match));
  return {
    pass,
    message: () =>
      pass
        ? `expected no ${signal} point matching ${JSON.stringify(match)}`
        : `expected a ${signal} point matching ${JSON.stringify(match)}; ${found.length} ${signal} point(s) recorded: ${JSON.stringify(found.map((r) => r.fields))}`,
  };
}

declare module "vitest" {
  // A merged declaration must repeat vitest's own type parameters exactly.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveRecorded(signal: string, match?: Record<string, unknown>): R;
  }
}
