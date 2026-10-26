import { describe, expect, it } from "vitest";
import { requestToken } from "../src/oidc.ts";
import { publish, type Steps } from "../src/run.ts";
import { samplePack } from "./helpers.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen { method: string; url: string; headers: Headers; body?: string }

function fakeRegistry(options: { verdict?: "pass" | "hold" | "fail"; exchange?: Response; pending?: number } = {}) {
  const seen: Seen[] = [];
  let polls = 0;
  const handler: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("token.actions.test")) return json({ value: "oidc-token" });
    if (url.endsWith("/api/oidc/exchange")) return options.exchange ?? json({ credential: "psc_secret", expires_at: "2026-10-26T01:00:00Z" });
    if (url.endsWith("/upload-url")) return json({ method: "PUT", url: "https://r2.test/staging/obj", headers: { "content-type": "application/zstd" } });
    if (url.startsWith("https://r2.test/")) return new Response(null, { status: 200 });
    if (url.endsWith("/uploaded")) return json({ size_bytes: 1 });
    if (url.endsWith("/@acme/gcp/1.0.0")) return json({ run_id: "run1", status: "queued", verdict: null, reason: null, milestones: [] }, 201);
    if (url.endsWith("/runs/run1")) {
      const done = polls++ >= (options.pending ?? 1);
      return json({ run_id: "run1", status: done ? "finished" : "running", verdict: done ? (options.verdict ?? "pass") : null, reason: null, milestones: [] });
    }
    return json({ error: "not-found" }, 404);
  };
  return { handler, seen };
}

const steps = (fetchFn: typeof fetch, order: string[] = []): Steps => ({
  runner: { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/oidc?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner", GITHUB_RUN_ID: "999", GITHUB_JOB: "publish" },
  fetch: fetchFn,
  vendor: async () => void order.push("vendor"),
  pack: async () => (order.push("pack"), samplePack()),
  sleep: async () => {},
  log: () => {},
});

const inputs = { pack: "@acme/gcp", version: "1.0.0", registry: "https://registry.test" };

describe("publish action (REQ-PUB-003 client side)", () => {
  it("vendors, packs, exchanges, uploads once, starts and polls with the run id as version key", async () => {
    const { handler, seen } = fakeRegistry();
    const order: string[] = [];
    const outcome = await publish(inputs, steps(handler, order));
    expect(order).toEqual(["vendor", "pack"]);
    expect(outcome).toMatchObject({ runId: "run1", verdict: "pass", sha256: samplePack().sha256 });

    expect(seen[0]!.url).toContain("audience=registry.claudinite.com");
    const exchange = seen.find((s) => s.url.endsWith("/exchange"))!;
    expect(JSON.parse(exchange.body!)).toEqual({ token: "oidc-token", pack: "@acme/gcp", version: "1.0.0", job: "publish" });
    expect(seen.filter((s) => s.method === "PUT")).toHaveLength(1);
    const registryCalls = seen.filter((s) => s.url.startsWith("https://registry.test"));
    for (const call of registryCalls) expect(call.headers.get("cloudflare-workers-version-key")).toBe("999");
    expect(seen.find((s) => s.method === "PUT")!.headers.get("authorization")).toBeNull();
    expect(JSON.parse(seen.find((s) => s.url.endsWith("/1.0.0") && s.method === "POST")!.body!)).toEqual({ sha256: samplePack().sha256 });
  });

  it("surfaces a refusal from the exchange naming its reason and does not upload", async () => {
    const { handler, seen } = fakeRegistry({ exchange: json({ reason: "oidc.workflow", message: "no match" }, 401) });
    await expect(publish(inputs, steps(handler))).rejects.toThrow(/exchange: no match \(HTTP 401, oidc.workflow\)/);
    expect(seen.some((s) => s.method === "PUT")).toBe(false);
  });

  it("returns a hold and a fail verdict as outcomes", async () => {
    expect((await publish(inputs, steps(fakeRegistry({ verdict: "hold" }).handler))).verdict).toBe("hold");
    expect((await publish(inputs, steps(fakeRegistry({ verdict: "fail" }).handler))).verdict).toBe("fail");
  });

  it("gives up polling after maxPolls", async () => {
    const { handler } = fakeRegistry({ pending: 99 });
    await expect(publish(inputs, { ...steps(handler), maxPolls: 2 })).rejects.toThrow(/did not finish/);
  });

  it("explains a missing OIDC permission", async () => {
    await expect(requestToken({}, fetch)).rejects.toThrow(/id-token: write/);
  });
});
