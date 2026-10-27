import type { PageId, TicketKind } from "./catalogue";
import { PAGES } from "./catalogue";

export const PAGES_PER_HOUR = 10;
export const HOUR_MS = 3_600_000;
/** An authenticated alert for the same key inside this span is counted and not raised again. */
export const PAGE_DEDUPE_MS = HOUR_MS;
export const TICKET_DEDUPE_MS = 24 * HOUR_MS;
/** A candidate that has burned this long without a completed rollback is the registry's problem, not the controller's. */
export const ROLLBACK_PATIENCE_MS = 10 * 60_000;

export interface RouterState {
  /** When each page of the last hour went out; storm pages are not counted. */
  sent: number[];
  stormAt: number | null;
  seen: Record<string, SeenAlert>;
  mutes: Record<string, number>;
  /** Support-hours pages raised outside the window, paged when it opens. */
  deferred: PageId[];
}

export interface SeenAlert {
  at: number;
  count: number;
  /** The page it belongs to; absent on a ticket. */
  page?: PageId;
  /** A person acknowledged it: while the condition keeps recurring it stays quiet. */
  acked?: boolean;
}

/** An acknowledged alert is forgotten once its condition has been quiet this long, so a new incident pages. */
export const ACK_QUIET_MS = 2 * HOUR_MS;

export const emptyRouterState = (): RouterState => ({ sent: [], stormAt: null, seen: {}, mutes: {}, deferred: [] });

/** UTC hours during which a support-hours page is paged rather than only ticketed. */
export interface SupportWindow {
  startHour: number;
  endHour: number;
}

export const inSupportHours = (nowMs: number, window: SupportWindow): boolean => {
  const hour = new Date(nowMs).getUTCHours();
  return hour >= window.startHour && hour < window.endHour;
};

/** What the alert's bad events say about the rollout in flight. */
export interface ReleaseContext {
  rolloutInProgress: boolean;
  /** Every bad event belongs to a candidate. */
  candidateOnly: boolean;
  incumbentBurning: boolean;
  candidateAtFull: boolean;
  rollbackFailed: boolean;
  /** How long the candidate has been burning without a completed rollback; null when it has not begun. */
  burningForMs: number | null;
}

export type AlertInput =
  | { kind: "page"; page: PageId; key: string; authenticated: boolean; mode: "pre-launch" | "launch"; release?: ReleaseContext }
  | { kind: "ticket"; ticket: TicketKind; key: string; authenticated: boolean };

export type DropReason = "unauthenticated" | "deduped" | "muted" | "acknowledged" | "controller" | "deploy_gate";

export type Delivery =
  | { kind: "page"; page: PageId }
  | { kind: "ticket"; source: { page: PageId } | { ticket: TicketKind }; reason: "ticket" | "support_hours" | "capped" };

export interface Routed {
  deliveries: Delivery[];
  dropped: DropReason | null;
  state: RouterState;
}

function prune(state: RouterState, now: number): RouterState {
  const seen = Object.fromEntries(Object.entries(state.seen).filter(([, v]) => now - v.at < (v.acked ? ACK_QUIET_MS : TICKET_DEDUPE_MS)));
  const mutes = Object.fromEntries(Object.entries(state.mutes).filter(([, until]) => until > now));
  return { ...state, sent: state.sent.filter((t) => now - t < HOUR_MS), seen, mutes };
}

/** Whether a candidate-only burn is left to the controller (or, before launch, to the deploy job) instead of paging. */
export function releaseVerdict(release: ReleaseContext | undefined, mode: "pre-launch" | "launch"): "page" | "controller" | "deploy_gate" {
  if (!release || !release.rolloutInProgress || !release.candidateOnly) return "page";
  if (mode === "pre-launch") return "deploy_gate";
  const escalates = release.incumbentBurning || release.candidateAtFull || release.rollbackFailed || (release.burningForMs ?? 0) >= ROLLBACK_PATIENCE_MS;
  return escalates ? "page" : "controller";
}

/** The cap: past ten pages in an hour a page is a ticket, and one storm page says so. */
function deliverPage(state: RouterState, page: PageId, now: number, out: Delivery[]): RouterState {
  if (state.sent.length < PAGES_PER_HOUR) {
    out.push({ kind: "page", page });
    return { ...state, sent: [...state.sent, now] };
  }
  out.push({ kind: "ticket", source: { page }, reason: "capped" });
  if (state.stormAt === null || now - state.stormAt >= HOUR_MS) {
    out.push({ kind: "page", page: "page.storm" });
    return { ...state, stormAt: now };
  }
  return state;
}

export function route(input: AlertInput, stateIn: RouterState, now: number, window: SupportWindow): Routed {
  const state = prune(stateIn, now);
  const refuse = (dropped: DropReason, next: RouterState = state): Routed => ({ deliveries: [], dropped, state: next });
  // An alert that did not authenticate is never merged with another: dropping a flood of forgeries to one would hide it.
  if (!input.authenticated) return refuse("unauthenticated");

  if (input.kind === "ticket") {
    const known = state.seen[`ticket|${input.key}`];
    if (known) return refuse("deduped", { ...state, seen: { ...state.seen, [`ticket|${input.key}`]: { at: known.at, count: known.count + 1 } } });
    return {
      deliveries: [{ kind: "ticket", source: { ticket: input.ticket }, reason: "ticket" }],
      dropped: null,
      state: { ...state, seen: { ...state.seen, [`ticket|${input.key}`]: { at: now, count: 1 } } },
    };
  }

  const def = PAGES[input.page];
  if (!def.trust) {
    const verdict = releaseVerdict(input.release, input.mode);
    if (verdict !== "page") return refuse(verdict);
  }
  if ((state.mutes[input.page] ?? 0) > now) return refuse("muted");
  const key = `page|${input.page}|${input.key}`;
  const known = state.seen[key];
  if (known?.acked) return refuse("acknowledged", { ...state, seen: { ...state.seen, [key]: { ...known, at: now, count: known.count + 1 } } });
  if (known && now - known.at < PAGE_DEDUPE_MS) return refuse("deduped", { ...state, seen: { ...state.seen, [key]: { at: known.at, count: known.count + 1 } } });
  const seen = { ...state.seen, [key]: { at: now, count: 1, page: input.page } };

  const deliveries: Delivery[] = [];
  if (def.supportHours && !inSupportHours(now, window)) {
    // Already ticketed and waiting for the window: another ticket every hour of the night would only be noise.
    if (state.deferred.includes(input.page)) return refuse("deduped");
    deliveries.push({ kind: "ticket", source: { page: input.page }, reason: "support_hours" });
    return { deliveries, dropped: null, state: { ...state, seen, deferred: [...state.deferred, input.page] } };
  }
  // Paged now, so the copy held for the window is no longer owed.
  return { deliveries, dropped: null, state: deliverPage({ ...state, seen, deferred: state.deferred.filter((p) => p !== input.page) }, input.page, now, deliveries) };
}

/** Pages held for the support window go out once it opens; a mute raised meanwhile still applies. */
export function drainDeferred(stateIn: RouterState, now: number, window: SupportWindow): Routed {
  const state = prune(stateIn, now);
  if (state.deferred.length === 0 || !inSupportHours(now, window)) return { deliveries: [], dropped: null, state };
  const deliveries: Delivery[] = [];
  let next: RouterState = { ...state, deferred: [] };
  for (const page of state.deferred) if ((next.mutes[page] ?? 0) <= now) next = deliverPage(next, page, now, deliveries);
  return { deliveries, dropped: null, state: next };
}

/** A person acknowledged the page: every alert of it seen so far stays quiet for as long as it keeps recurring. */
export function acknowledgePage(state: RouterState, page: PageId): RouterState {
  const seen = Object.fromEntries(Object.entries(state.seen).map(([k, v]) => [k, v.page === page ? { ...v, acked: true } : v]));
  return { ...state, seen, deferred: state.deferred.filter((p) => p !== page) };
}

/** Records a mute; later alerts of that page are dropped until it lapses. */
export function mutePage(state: RouterState, page: PageId, until: number): RouterState {
  return { ...state, mutes: { ...state.mutes, [page]: Math.max(until, state.mutes[page] ?? 0) } };
}
