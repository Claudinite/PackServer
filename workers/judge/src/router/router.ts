import { drainDeferred, mutePage, route, type AlertFields, type Delivery, type DropReason, type PageId, type SupportWindow } from "@packserver/core/alerts";
import type { Telemetry } from "@packserver/core/telemetry";
import type { Clock } from "@packserver/ports";
import type { AdminRequest } from "@packserver/schema";
import type { Detection } from "../alerts/detect";
import type { AdminClient } from "../heartbeat/admin-client";
import { runSafeAction } from "../safe-actions/run";
import type { Dispatcher } from "./dispatch";
import type { RouterStore } from "./store";

export interface RouterDeps {
  clock: Clock;
  store: RouterStore;
  dispatcher: Dispatcher;
  admin: AdminClient;
  emit: Telemetry["emit"];
  window: SupportWindow;
}

export interface Raised {
  delivered: Delivery[];
  dropped: DropReason | null;
  actionsFailed: number;
}

/** The one place an alert becomes a page, a ticket or nothing: its safe actions first, then the routing decision, then delivery. */
export function alertRouter(deps: RouterDeps) {
  const { store, dispatcher, admin, emit } = deps;

  async function act(actions: readonly AdminRequest[], actionKey: string | undefined): Promise<{ ran: number; failed: number }> {
    if (actions.length === 0) return { ran: 0, failed: 0 };
    if (actionKey && (await store.acted(actionKey))) return { ran: 0, failed: 0 };
    let failed = 0;
    for (const request of actions) {
      const outcome = await runSafeAction(admin, request);
      if (!outcome.ok) {
        failed++;
        console.error(JSON.stringify({ event: "judge.safe_action_failed", method: request.method, reason: outcome.reason }));
      }
    }
    if (failed === 0 && actionKey) await store.markActed(actionKey);
    return { ran: actions.length, failed };
  }

  return {
    async raise(detection: Detection, mode: "pre-launch" | "launch", authenticated = true): Promise<Raised> {
      const { target } = detection;
      const outcome = await act(detection.actions, detection.actionKey);
      const fields: AlertFields = outcome.failed > 0 ? { ...detection.fields, actionFailed: true } : detection.fields;
      const now = deps.clock.now();
      const routed = route(
        target.kind === "page"
          ? { kind: "page", page: target.page, key: target.key, authenticated, mode, ...(target.release ? { release: target.release } : {}) }
          : { kind: "ticket", ticket: target.ticket, key: target.key, authenticated },
        await store.state(),
        now,
        deps.window,
      );
      await store.putState(routed.state);
      if (routed.dropped === "unauthenticated") emit("monitoring.alert_rejected", { reason: "unauthenticated" });
      for (const delivery of routed.deliveries) await dispatcher.deliver(delivery, fields, now);
      return { delivered: routed.deliveries, dropped: routed.dropped, actionsFailed: outcome.failed };
    },

    /** Pages held for the support window, once it has opened. */
    async drain(): Promise<number> {
      const now = deps.clock.now();
      const drained = drainDeferred(await store.state(), now, deps.window);
      await store.putState(drained.state);
      for (const delivery of drained.deliveries) await dispatcher.deliver(delivery, { at: new Date(now).toISOString() }, now);
      return drained.deliveries.length;
    },

    async mute(page: PageId, until: number): Promise<void> {
      await store.putState(mutePage(await store.state(), page, until));
    },

    /** A person closed the ticket for a page: the page is acknowledged on the ops page's record. */
    async acknowledge(page: string): Promise<boolean> {
      return (await runSafeAction(admin, { method: "acknowledge_page", page })).ok;
    },
  };
}
export type AlertRouter = ReturnType<typeof alertRouter>;
