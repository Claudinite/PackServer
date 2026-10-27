import { acknowledgePage, drainDeferred, mutePage, route, type AlertFields, type Delivery, type DropReason, type PageId, type RouterState, type SupportWindow } from "@packserver/core/alerts";
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

export interface Batch {
  raised: Raised[];
  /** Pages released from the support-hours queue. */
  drained: number;
  /** Deliveries that threw; every other alert was still routed and sent. */
  errors: string[];
}

/** The one place an alert becomes a page, a ticket or nothing: its safe actions first, then the routing decision, then delivery. */
export function alertRouter(deps: RouterDeps) {
  const { store, dispatcher, admin, emit } = deps;

  async function act(actions: readonly AdminRequest[], actionKey: string | undefined): Promise<{ failed: number }> {
    if (actions.length === 0) return { failed: 0 };
    if (actionKey && (await store.acted(actionKey))) return { failed: 0 };
    let failed = 0;
    for (const request of actions) {
      const outcome = await runSafeAction(admin, request);
      if (!outcome.ok) {
        failed++;
        console.error(JSON.stringify({ event: "judge.safe_action_failed", method: request.method, reason: outcome.reason }));
      }
    }
    if (failed === 0 && actionKey) await store.markActed(actionKey);
    return { failed };
  }

  /**
   * Routes every detection of a cycle against one in-memory state and writes it once at the end, because KV
   * takes one write a second to a key. A delivery that throws is recorded and never stops the rest; the state
   * still lands, so an alert whose action ran is not raised again as if new.
   */
  async function raiseAll(detections: readonly Detection[], mode: "pre-launch" | "launch", options: { authenticated?: boolean; drain?: boolean } = {}): Promise<Batch> {
    const authenticated = options.authenticated ?? true;
    const batch: Batch = { raised: [], drained: 0, errors: [] };
    let state: RouterState = await store.state();
    try {
      for (const detection of detections) {
        const { target } = detection;
        const outcome = await act(detection.actions, detection.actionKey);
        const fields: AlertFields = outcome.failed > 0 ? { ...detection.fields, actionFailed: true } : detection.fields;
        const now = deps.clock.now();
        const routed = route(
          target.kind === "page"
            ? { kind: "page", page: target.page, key: target.key, authenticated, mode, ...(target.release ? { release: target.release } : {}) }
            : { kind: "ticket", ticket: target.ticket, key: target.key, authenticated },
          state,
          now,
          deps.window,
        );
        state = routed.state;
        if (routed.dropped === "unauthenticated") emit("monitoring.alert_rejected", { reason: "unauthenticated" });
        for (const delivery of routed.deliveries) {
          try {
            await dispatcher.deliver(delivery, fields, now);
          } catch (error) {
            batch.errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        batch.raised.push({ delivered: routed.deliveries, dropped: routed.dropped, actionsFailed: outcome.failed });
      }
      if (options.drain) {
        const now = deps.clock.now();
        const drained = drainDeferred(state, now, deps.window);
        state = drained.state;
        for (const delivery of drained.deliveries) {
          try {
            await dispatcher.deliver(delivery, { at: new Date(now).toISOString() }, now);
          } catch (error) {
            batch.errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        batch.drained = drained.deliveries.length;
      }
    } finally {
      await store.putState(state);
      await dispatcher.flush();
    }
    return batch;
  }

  return {
    raiseAll,

    async raise(detection: Detection, mode: "pre-launch" | "launch", authenticated = true): Promise<Raised> {
      const batch = await raiseAll([detection], mode, { authenticated });
      if (batch.errors.length > 0) throw new Error(batch.errors.join("; "));
      return batch.raised[0] as Raised;
    },

    async mute(page: PageId, until: number): Promise<void> {
      await store.putState(mutePage(await store.state(), page, until));
    },

    /** A person closed the ticket for a page: it is acknowledged on the ops page's record and stays quiet while its condition recurs. */
    async acknowledge(page: PageId): Promise<boolean> {
      const ok = (await runSafeAction(admin, { method: "acknowledge_page", page })).ok;
      if (ok) await store.putState(acknowledgePage(await store.state(), page));
      return ok;
    },
  };
}
export type AlertRouter = ReturnType<typeof alertRouter>;
