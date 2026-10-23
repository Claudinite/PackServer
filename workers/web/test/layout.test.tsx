import { securityHeaders } from "@packserver/ui";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { renderPage } from "../src/layout";

const app = new Hono();
app.use(securityHeaders());
app.get("/", (c) => renderPage(c, { title: "Home", current: "/" }));

describe("page shell", () => {
  it("runs its inline code only under the response nonce", async () => {
    const res = await app.request("/");
    const body = await res.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<style nonce="${nonce}">`);
    const scripts = body.match(/<script[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toBe(`<script nonce="${nonce}">`);
    expect(body).toContain("Claudinite Packs");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
