import type { Telemetry } from "@packserver/core/telemetry";
import type { AlertsConfig, JudgeRuntime } from "../bindings";
import type { ScheduledDeps } from "../gates/scheduled";
import { dispatcher } from "./dispatch";
import { alertRouter } from "./router";
import { routerStore } from "./store";

/** The router, its dispatcher and store, built from the runtime's ports. */
export function composeAlerts(runtime: JudgeRuntime, alerts: AlertsConfig, emit: Telemetry["emit"]) {
  const { ports, config } = runtime;
  const kv = ports.kv["GATES_KV"];
  if (!kv) throw new Error("the judge's KV namespaces are not bound");
  const store = routerStore(kv);
  const out = dispatcher({ pager: alerts.pager, mail: ports.mail, config: alerts.dispatch, store, emit });
  const router = alertRouter({ clock: ports.clock, store, dispatcher: out, admin: config.adminClient, emit, window: alerts.window });
  return { store, dispatcher: out, router };
}

/** What the cron hands the cycle for its alert half. */
export function scheduledAlerts(runtime: JudgeRuntime, emit: Telemetry["emit"]): Pick<ScheduledDeps, "alerts" | "alertsMissing"> {
  const { alerts, alertsMissing } = runtime.config;
  if (!alerts) return { alertsMissing };
  const wiring = composeAlerts(runtime, alerts, emit);
  return {
    alertsMissing: [],
    alerts: { data: alerts.data, router: wiring.router, dispatcher: wiring.dispatcher, store: wiring.store, pager: alerts.pager, opsPageUrl: alerts.dispatch.opsPageUrl, platform: alerts.platform },
  };
}
