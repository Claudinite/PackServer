import { adminAllows } from "./support";
import { describe, expect, it } from "vitest";
import { ADMIN_CALLER_HEADER, adminClient } from "../src/heartbeat/admin-client";

describe("the admin client", () => {
  it("posts the contract's request as the judge, with the release header", async () => {
    let seen: { url: string; headers: Headers; body: unknown } | undefined;
    const client = adminClient(
      { fetch: async (url, init) => ((seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }), Response.json({ ok: true, audit_id: "a1" })) },
      "rel-1",
    );
    expect(await client.call({ method: "set_telemetry_mode", mode: "economy" })).toEqual({ ok: true, audit_id: "a1" });
    expect(seen?.headers.get(ADMIN_CALLER_HEADER)).toBe("judge");
    expect(seen?.headers.get("x-packserver-release")).toBe("rel-1");
    expect(seen?.body).toEqual({ method: "set_telemetry_mode", mode: "economy" });
  });

  it("rejects an answer that is not the contract's", async () => {
    const client = adminClient({ fetch: async () => Response.json({ hello: 1 }) }, "rel-1");
    await expect(client.call({ method: "acknowledge_page", page: "p" })).rejects.toThrow();
  });

  it("only asks for methods the contract allows the judge", () => {
    expect(adminAllows("judge", "set_telemetry_mode")).toBe(true);
    expect(adminAllows("judge", "roll_back")).toBe(false);
  });
});
