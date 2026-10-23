import { ANALYTICS_DATASETS, SIGNALS, SIGNAL_NAMES, type AnalyticsDataset, type SignalName } from "@packserver/schema";

/** The catalogue lives in `@packserver/schema`; this re-export is the telemetry code's one door to it. */
export { ANALYTICS_DATASETS, SIGNALS, SIGNAL_NAMES, type AnalyticsDataset, type SignalName };

const KNOWN = new Set<string>(SIGNAL_NAMES);
export const isSignal = (name: string): name is SignalName => KNOWN.has(name);

/** The dataset a signal's point lands in; everything unlisted is a domain event. */
export function datasetFor(name: string): AnalyticsDataset {
  if (name === "http.request") return "request_outcomes";
  if (name === "download.served") return "downloads";
  if (name.startsWith("validation.")) return "validation_events";
  if (name === "synthetic.probe") return "synthetic_probes";
  if (name === "gate.evaluated") return "gate_results";
  if (name === "budget.usage") return "budget";
  return "domain_events";
}
