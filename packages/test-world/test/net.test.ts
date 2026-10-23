import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness, type TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Net } from "../fakes/net";
import { turnstileHandler } from "../fakes/turnstile";
import { createFakePorts } from "@packserver/ports/fakes";
import { TURNSTILE_PASS_TOKEN } from "@packserver/ports/fakes";

const net = new Net();
let server: TestHarness;
const here = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  net.use((request) => (new URL(request.url).host === "faked.test" ? new Response("from the fake") : undefined));
  net.use(turnstileHandler(createFakePorts().turnstile));
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

  it("fails a host nobody faked instead of reaching the network, and tells the Worker so", async () => {
    net.reset();
    const res = await call("https://nobody-faked-this.test/");
    expect(res.status).toBe(500);
    expect(net.requests()).toEqual([]);
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
