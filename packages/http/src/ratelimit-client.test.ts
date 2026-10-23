import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimitClient } from "./ratelimit";

const keyOf = async (ip?: string) => {
  const app = new Hono().get("/", (c) => c.text(rateLimitClient(c)));
  return (await app.request("https://x.test/", { headers: ip ? { "cf-connecting-ip": ip } : {} })).text();
};

describe("what a rate limit counts a client by", () => {
  it("keeps an IPv4 address whole", async () => {
    expect(await keyOf("203.0.113.9")).toBe("203.0.113.9");
    expect(await keyOf()).toBe("unknown");
  });

  it("collapses an IPv6 address to its /64, however it is written", async () => {
    const expected = "2001:db8:1:2::/64";
    for (const ip of ["2001:db8:1:2::1", "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:DB8:1:2:ffff::", "2001:db8:1:2:3:4:5:6"]) expect(await keyOf(ip), ip).toBe(expected);
    expect(await keyOf("2001:db8:1:3::1")).not.toBe(expected);
  });

  it("expands a leading compression", async () => {
    expect(await keyOf("::1")).toBe("0:0:0:0::/64");
  });
});
