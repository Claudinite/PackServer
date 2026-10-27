import { describe, expect, it } from "vitest";
import { drainDeferred, emptyRouterState, mutePage, route, PAGES_PER_HOUR, type AlertInput, type RouterState, type SupportWindow } from "../index";

const WINDOW: SupportWindow = { startHour: 7, endHour: 19 };
const NOON = Date.UTC(2026, 9, 27, 12, 0, 0);
const NIGHT = Date.UTC(2026, 9, 27, 3, 0, 0);

const page = (name: Parameters<typeof pageOf>[0], key: string = name, extra: Partial<Extract<AlertInput, { kind: "page" }>> = {}): AlertInput => pageOf(name, key, extra);
function pageOf(name: Extract<AlertInput, { kind: "page" }>["page"], key: string, extra: Partial<Extract<AlertInput, { kind: "page" }>>): AlertInput {
  return { kind: "page", page: name, key, authenticated: true, mode: "launch", ...extra };
}

describe("dedupe", () => {
  it("merges a repeat of an authenticated alert and counts it", () => {
    const first = route(page("page.index_key_changed"), emptyRouterState(), NOON, WINDOW);
    expect(first.deliveries).toEqual([{ kind: "page", page: "page.index_key_changed" }]);
    const again = route(page("page.index_key_changed"), first.state, NOON + 60_000, WINDOW);
    expect(again.dropped).toBe("deduped");
    expect(Object.values(again.state.seen)[0]?.count).toBe(2);
    expect(route(page("page.index_key_changed"), first.state, NOON + 3_700_000, WINDOW).deliveries).toHaveLength(1);
  });

  it("never merges an alert that did not authenticate, and delivers nothing for it", () => {
    let state = emptyRouterState();
    for (let i = 0; i < 3; i++) {
      const out = route({ ...page("page.hash_mismatch"), authenticated: false }, state, NOON, WINDOW);
      expect(out.dropped).toBe("unauthenticated");
      expect(out.deliveries).toEqual([]);
      state = out.state;
    }
    expect(state.seen).toEqual({});
  });

  it("keeps different keys apart", () => {
    const a = route(page("page.hash_mismatch", "a"), emptyRouterState(), NOON, WINDOW);
    expect(route(page("page.hash_mismatch", "b"), a.state, NOON, WINDOW).deliveries).toHaveLength(1);
  });
});

describe("the page cap", () => {
  it("sends ten pages an hour, files the eleventh as a ticket and sends one storm page", () => {
    let state: RouterState = emptyRouterState();
    const delivered: string[] = [];
    for (let i = 0; i < PAGES_PER_HOUR; i++) {
      const out = route(page("page.hash_mismatch", `k${i}`), state, NOON + i, WINDOW);
      delivered.push(...out.deliveries.map((d) => (d.kind === "page" ? d.page : "ticket")));
      state = out.state;
    }
    expect(delivered).toEqual(Array(10).fill("page.hash_mismatch"));
    const eleventh = route(page("page.hash_mismatch", "k10"), state, NOON + 100, WINDOW);
    expect(eleventh.deliveries).toEqual([
      { kind: "ticket", source: { page: "page.hash_mismatch" }, reason: "capped" },
      { kind: "page", page: "page.storm" },
    ]);
    const twelfth = route(page("page.hash_mismatch", "k11"), eleventh.state, NOON + 200, WINDOW);
    expect(twelfth.deliveries).toEqual([{ kind: "ticket", source: { page: "page.hash_mismatch" }, reason: "capped" }]);
    const later = route(page("page.hash_mismatch", "k12"), twelfth.state, NOON + 3_700_000, WINDOW);
    expect(later.deliveries).toEqual([{ kind: "page", page: "page.hash_mismatch" }]);
  });
});

describe("support hours", () => {
  it("is a ticket at once and a page when the window opens", () => {
    const night = route(page("page.takedown_overdue"), emptyRouterState(), NIGHT, WINDOW);
    expect(night.deliveries).toEqual([{ kind: "ticket", source: { page: "page.takedown_overdue" }, reason: "support_hours" }]);
    expect(drainDeferred(night.state, NIGHT + 3_600_000, WINDOW).deliveries).toEqual([]);
    const morning = drainDeferred(night.state, Date.UTC(2026, 9, 27, 7, 5, 0), WINDOW);
    expect(morning.deliveries).toEqual([{ kind: "page", page: "page.takedown_overdue" }]);
    expect(drainDeferred(morning.state, Date.UTC(2026, 9, 27, 7, 10, 0), WINDOW).deliveries).toEqual([]);
  });

  it("does not ticket the same waiting page again, and does not page it twice when it recurs inside the window", () => {
    const night = route(page("page.takedown_overdue"), emptyRouterState(), NIGHT, WINDOW);
    expect(route(page("page.takedown_overdue"), night.state, NIGHT + 2 * 3_600_000, WINDOW).dropped).toBe("deduped");
    const morning = Date.UTC(2026, 9, 27, 8, 0, 0);
    const live = route(page("page.takedown_overdue"), night.state, morning, WINDOW);
    expect(live.deliveries).toEqual([{ kind: "page", page: "page.takedown_overdue" }]);
    expect(drainDeferred(live.state, morning + 1000, WINDOW).deliveries).toEqual([]);
  });

  it("pages at once inside the window", () => {
    expect(route(page("page.monitoring_dead"), emptyRouterState(), NOON, WINDOW).deliveries).toEqual([{ kind: "page", page: "page.monitoring_dead" }]);
  });
});

describe("release-aware routing", () => {
  const release = { rolloutInProgress: true, candidateOnly: true, incumbentBurning: false, candidateAtFull: false, rollbackFailed: false, burningForMs: 60_000 };
  it("leaves a candidate-only burn to the controller", () => {
    expect(route(page("page.read_path_burn", "burn", { release }), emptyRouterState(), NOON, WINDOW).dropped).toBe("controller");
  });
  it("fails the deploy job and has no controller before launch", () => {
    expect(route(page("page.read_path_burn", "burn", { release, mode: "pre-launch" }), emptyRouterState(), NOON, WINDOW).dropped).toBe("deploy_gate");
  });
  it.each([
    ["the incumbent burns too", { incumbentBurning: true }],
    ["no rollback completed in ten minutes", { burningForMs: 600_000 }],
    ["the rollback failed", { rollbackFailed: true }],
    ["the candidate is at 100%", { candidateAtFull: true }],
  ])("pages when %s", (_, patch) => {
    expect(route(page("page.read_path_burn", "burn", { release: { ...release, ...patch } }), emptyRouterState(), NOON, WINDOW).deliveries).toHaveLength(1);
  });
  it("never routes a trust page to the controller", () => {
    expect(route(page("page.hash_mismatch", "h", { release }), emptyRouterState(), NOON, WINDOW).deliveries).toHaveLength(1);
  });
  it("does not mute because a deployment runs: no rollout, no routing", () => {
    expect(route(page("page.read_path_burn", "burn", { release: { ...release, rolloutInProgress: false } }), emptyRouterState(), NOON, WINDOW).deliveries).toHaveLength(1);
  });
});

describe("mutes", () => {
  it("drops a muted page until the mute lapses", () => {
    const state = mutePage(emptyRouterState(), "page.hash_mismatch", NOON + 3_600_000);
    expect(route(page("page.hash_mismatch"), state, NOON, WINDOW).dropped).toBe("muted");
    expect(route(page("page.hash_mismatch"), state, NOON + 3_600_001, WINDOW).deliveries).toHaveLength(1);
  });
});

describe("tickets", () => {
  it("deliver once a day per key", () => {
    const t: AlertInput = { kind: "ticket", ticket: "abuse_flood", key: "abuse_flood", authenticated: true };
    const first = route(t, emptyRouterState(), NOON, WINDOW);
    expect(first.deliveries).toEqual([{ kind: "ticket", source: { ticket: "abuse_flood" }, reason: "ticket" }]);
    expect(route(t, first.state, NOON + 1000, WINDOW).dropped).toBe("deduped");
    expect(route(t, first.state, NOON + 25 * 3_600_000, WINDOW).deliveries).toHaveLength(1);
  });
});
