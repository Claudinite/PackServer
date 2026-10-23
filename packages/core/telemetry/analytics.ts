import type { Stats, StatsPoint } from "@packserver/ports";
import { datasetFor, type AnalyticsDataset } from "./signals";

export interface DatasetBinding {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/**
 * The Stats port over a Worker's Analytics Engine bindings. A point goes to the dataset its
 * name selects; a Worker without that dataset bound writes it as a domain event, and one
 * without even that says so once on the console instead of dropping the point unseen.
 */
export function analyticsStats(
  datasets: Partial<Record<AnalyticsDataset, DatasetBinding | undefined>>,
  warn: (line: string) => void = (line) => console.warn(line),
): Stats {
  const warned = new Set<string>();
  return {
    write(point: StatsPoint) {
      const wanted = datasetFor(point.name);
      const target = datasets[wanted] ?? datasets.domain_events;
      if (!target) {
        if (!warned.has(wanted)) {
          warned.add(wanted);
          warn(JSON.stringify({ event: "telemetry.no_dataset", dataset: wanted }));
        }
        return;
      }
      target.writeDataPoint({ indexes: [point.index ?? point.name], blobs: point.blobs, doubles: point.doubles });
    },
  };
}
