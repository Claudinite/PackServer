import { describe, expect, it } from "vitest";
import type { ApiRequest, Driver } from "../drivers/driver";
import { Aliases } from "../world/alias";
import { createOperator } from "../world/areas/operator";
import { createUsers } from "../world/areas/users";

function recording(kind: "http" | "inprocess", answer: (req: ApiRequest, n: number) => { status: number; text?: string }) {
  const seen: ApiRequest[] = [];
  const driver = {
    kind,
    surfaces: ["web"],
    http: {
      request: async (req: ApiRequest) => {
        seen.push(req);
        const { status, text = "" } = answer(req, seen.length);
        return { status, headers: new Headers(), text, json: () => JSON.parse(text) as unknown };
      },
    },
  } as unknown as Driver;
  return { driver, seen };
}

describe("a deployed host's self-test, as the World asks it", () => {
  it("drains the budget of the principal it is told to, not a shared one", async () => {
    const result = JSON.stringify({ version_id: "v", release_id: "r", ok: true, checks: [] });
    const { driver, seen } = recording("http", (_req, n) => (n > 3 ? { status: 429 } : { status: 200, text: result }));
    const drained = await createOperator(driver).drainSelfTestBudget({ principal: "drain-a" });
    expect(drained.answered).toBe(3);
    expect(drained.refusal?.reason).toBe("rate-limited");
    expect(seen.map((r) => r.signAs)).toEqual(["drain-a", "drain-a", "drain-a", "drain-a"]);
    expect(seen.every((r) => !r.unsigned)).toBe(true);
  });

  it("gives each call without a principal a key id of its own", async () => {
    const result = JSON.stringify({ version_id: "v", release_id: "r", ok: true, checks: [] });
    const { driver, seen } = recording("http", () => ({ status: 200, text: result }));
    const operator = createOperator(driver);
    await operator.selfTest();
    await operator.selfTest();
    expect(new Set(seen.map((r) => r.signAs)).size).toBe(2);
  });

  it("asks as a visitor does: unsigned, so a gated candidate and production both answer it as an unknown path", async () => {
    const { driver, seen } = recording("http", () => ({ status: 404, text: "Not Found" }));
    const outcome = await createUsers(driver, new Aliases("visitor")).visitor().selfTest();
    expect(outcome.constructor.name).toBe("NotFound");
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r.unsigned === true)).toBe(true);
  });
});
