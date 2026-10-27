import { completedAttrs, heldAttrs, prioritisedAttrs } from "@packserver/core/moderation";
import { describe, expect, it } from "vitest";
import { runAlerts } from "../src/alerts/cycle";
import { alertHarness, row, toHour } from "./alert-support";

const MIN = 60_000;

/** The rows the registry's own code writes, read by the judge's detector without a hand-made attribute in between. */
describe("the moderation signals the takedown timer reads (REQ-MOD-009)", () => {
  async function overdue(declaredBy: number | null, later: Array<ReturnType<typeof row>> = []) {
    const h = alertHarness({ strictKv: true });
    toHour(h.fakes.clock, 12);
    h.data.rows = [row("moderation.report_prioritised", prioritisedAttrs({ id: "r1", pack: "@acme/lib", version: "1.0.0", declaredBy }), { ts: h.fakes.clock.now() - 61 * MIN }), ...later];
    await runAlerts(h.cycleDeps());
    return h.admin.calls;
  }

  it("holds a report whose declared count is known and at most 100", async () => {
    expect(await overdue(12)).toEqual([{ method: "quarantine_version", pack: "@acme/lib", version: "1.0.0", reason: "security report undecided for an hour" }]);
    expect(await overdue(0)).toHaveLength(1);
    expect(await overdue(100)).toHaveLength(1);
  });

  it("holds nothing declared by 101 repositories or an unknown number", async () => {
    expect(await overdue(101)).toEqual([]);
    expect(await overdue(null)).toEqual([]);
  });

  it("stops counting when a person completes the report or a hold already carries it", async () => {
    expect(await overdue(12, [row("moderation.takedown_completed", completedAttrs("r1"))])).toEqual([]);
    expect(await overdue(12, [row("moderation.quarantined", heldAttrs({ id: "r1", pack: "@acme/lib", version: "1.0.0" }, "abuse_standing"))])).toEqual([]);
  });
});
