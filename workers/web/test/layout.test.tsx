import { securityHeaders } from "@packserver/ui";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { renderPage } from "../src/layout";

const app = new Hono();
app.use(securityHeaders());
app.get("/", (c) => renderPage(c, { title: "Home", current: "/" }));

describe("page shell", () => {
  it("runs its stylesheet under the response nonce and carries no script", async () => {
    const res = await app.request("/");
    const body = await res.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<style nonce="${nonce}">`);
    expect(body).not.toMatch(/<script/i);
    expect(body).toContain("Claudinite Packs");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
