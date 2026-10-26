import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness, type TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isHarnessTraffic, Net } from "../fakes/net";
import { turnstileHandler } from "../fakes/turnstile";
import { createFakePorts } from "@packserver/ports/fakes";
import { TURNSTILE_PASS_TOKEN } from "@packserver/ports/fakes";

const net = new Net();
let server: TestHarness;
const here = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  net.use((request) => (new URL(request.url).host === "faked.test" ? new Response("from the fake") : undefined));
  net.use(turnstileHandler(createFakePorts().turnstile));
  net.freeze();
  net.listen();
  server = createTestHarness({
    workers: [{ config: { name: "egress", main: join(here, "egress-worker.ts"), compatibility_date: "2026-10-01" } as never }],
  });
  await server.listen();
}, 60_000);
afterAll(async () => {
  net.close();
  await server?.close();
});

const call = (to: string, init?: RequestInit) => server.getWorker("egress").fetch(`http://egress.test/?to=${encodeURIComponent(to)}`, init as never);

describe("outbound traffic is fail-closed", () => {
  it("answers a host a fake claims, and records it on the wire", async () => {
    const res = await call("https://faked.test/x");
    expect([res.status, await res.text()]).toEqual([200, "from the fake"]);
    expect(net.requests().map((r) => [r.target, r.op])).toContainEqual(["faked.test", "GET /x"]);
  });

  it("never reaches a reachable host nobody faked, tells the Worker so, and remembers the call for the scenario", async () => {
    let reached = 0;
    const listener: Server = createServer((_req, res) => {
      reached++;
      res.end("the real network");
    });
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    try {
      net.reset();
      const { port } = listener.address() as { port: number };
      const res = await call(`http://127.0.0.1:${port}/secret`);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("the real network");
      expect(reached).toBe(0);
      expect(net.requests()).toEqual([]);
      expect(net.unfaked()).toEqual([`GET http://127.0.0.1:${port}/secret`]);
      net.reset();
      expect(net.unfaked()).toEqual([]);
    } finally {
      listener.close();
    }
  });

  it("drops handlers a scenario added at reset, and keeps the standing ones", async () => {
    net.use(() => new Response("scenario only"));
    net.reset();
    expect((await call("https://faked.test/x")).status).toBe(200);
    expect((await call("https://other.test/x")).status).toBe(500);
  });

  it("serves the Turnstile siteverify fake from the ports fake: only the always-pass token succeeds", async () => {
    const verify = async (response: string) => {
      const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: "s", response }) });
      return (await res.json()) as { success: boolean };
    };
    expect((await verify(TURNSTILE_PASS_TOKEN)).success).toBe(true);
    expect((await verify("nope")).success).toBe(false);
  });
});

describe("the harness's own traffic is not the system calling out", () => {
  it("lets the test process reach the harness on loopback, and no Worker and no other host", () => {
    const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
    expect(isHarnessTraffic(req("http://127.0.0.1:4000/api/oidc/exchange"))).toBe(true);
    expect(isHarnessTraffic(req("http://127.0.0.1:4000/__control/now"))).toBe(true);
    expect(isHarnessTraffic(req("http://127.0.0.1:4000/secret", { "cf-worker": "egress" }))).toBe(false);
    expect(isHarnessTraffic(req("https://api.example/cdn-cgi/local/platform-proxy"))).toBe(false);
  });
});
