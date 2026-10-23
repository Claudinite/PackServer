import { describe, expect, it } from "vitest";
import { scenario } from "../scenario";

describe("scenario()", () => {
  it("refuses a title that does not start with a test id", () => {
    expect(() => scenario("a pack can be yanked", async () => {})).toThrow(/must start with a test id/);
  });

  it("refuses an id no page of docs/testing specifies", () => {
    expect(() => scenario("IT-ACC-999 invented", async () => {})).toThrow(/IT-ACC-999, which no page of docs\/testing specifies/);
  });
});
