import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { REFUSAL_REASONS } from "@packserver/schema";
import { refusal, REFUSAL_STATUS, VERSION_HEADER, versionHeader } from "./index";

describe("IT-OPS-006 version header", () => {
  const app = new Hono();
  app.use(versionHeader("rel-7"));
  app.get("/ok", (c) => c.text("hi"));
  app.get("/boom", () => {
    throw new Error("boom");
  });
  app.get("/refused", () => refusal("signed-out"));
  app.get("/redirect", () => Response.redirect("https://example.com/x", 302));

  it.each(["/ok", "/boom", "/refused", "/redirect", "/nowhere"])("is on %s", async (path) => {
    const res = await app.request(path);
    expect(res.headers.get(VERSION_HEADER)).toBe("rel-7");
  });
});

describe("refusals", () => {
  it("has a status for every register word", () => {
    expect(Object.keys(REFUSAL_STATUS).sort()).toEqual([...REFUSAL_REASONS].sort());
  });

  it("carries the reason word, message and Retry-After", async () => {
    const res = refusal("rate-limited", { retry_after_s: 30, message: "slow down" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ reason: "rate-limited", message: "slow down", retry_after_s: 30 });
  });
});
