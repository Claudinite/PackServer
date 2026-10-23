import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpDriver, type Fetch } from "../drivers/http";
import { HttpEnvError, readHttpEnv } from "../drivers/http-env";
import { createWorldHarness, type WorldHarness } from "../harness";
import { InfrastructureError } from "../world/errors";
import { createWorld } from "../world/world";
import { SMOKE } from "../world/smoke";

const BASE = { PACKSERVER_BASE_URL: "https://registry-staging.claudinite.com" };

describe("the http driver's environment contract", () => {
  it("needs a base URL and refuses plain http to a remote host", () => {
    expect(() => readHttpEnv({})).toThrow(HttpEnvError);
    expect(() => readHttpEnv({ PACKSERVER_BASE_URL: "http://registry.claudinite.com" })).toThrow(/https/);
    expect(readHttpEnv({ PACKSERVER_BASE_URL: "http://127.0.0.1:8787" }).baseUrl.host).toBe("127.0.0.1:8787");
  });

  it("defaults the probe tenant and reads the optional pieces", () => {
    const env = readHttpEnv({ ...BASE, PACKSERVER_PROBE_TENANT: "" });
    expect([env.probeTenant, env.versionOverride, env.access, env.expectedReleases]).toEqual(["@probe", "", null, null]);
  });

  it("refuses an override it could not assert, because Cloudflare ignores an invalid one silently", () => {
    expect(() => readHttpEnv({ ...BASE, PACKSERVER_VERSION_OVERRIDE: 'web="abc"' })).toThrow(/EXPECTED_RELEASE/);
    expect(readHttpEnv({ ...BASE, PACKSERVER_VERSION_OVERRIDE: 'web="abc"', PACKSERVER_EXPECTED_RELEASE: "r1, r2" }).expectedReleases).toEqual(new Set(["r1", "r2"]));
  });

  it("takes the Access token as a pair and only with the host it is for", () => {
    expect(() => readHttpEnv({ ...BASE, CF_ACCESS_CLIENT_ID: "id" })).toThrow(/come together/);
    expect(() => readHttpEnv({ ...BASE, CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "s" })).toThrow(/ACCESS_HOST/);
  });
});

const respond = (release: string | null = "r1"): Response =>
  new Response("{}", { status: 404, headers: release ? { "x-packserver-version": release } : {} });

function driverWith(env: Record<string, string>, answer: () => Response) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch: Fetch = async (url, init) => {
    sent.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    return answer();
  };
  return { driver: new HttpDriver(readHttpEnv({ ...BASE, ...env }), doFetch), sent };
}

describe("the http driver's requests", () => {
  it("sends the Access token and the override only where they belong", async () => {
    const { driver, sent } = driverWith(
      { CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret", PACKSERVER_ACCESS_HOST: "registry-canary.claudinite.com", PACKSERVER_VERSION_OVERRIDE: 'web="v"', PACKSERVER_EXPECTED_RELEASE: "r1" },
      () => respond(),
    );
    await driver.http.request({ surface: "web", method: "GET", path: "/x" });
    expect(sent[0]!.headers).not.toHaveProperty("CF-Access-Client-Id");
    expect(sent[0]!.headers["Cloudflare-Workers-Version-Overrides"]).toBe('web="v"');

    const canary = driverWith(
      { PACKSERVER_BASE_URL: "https://registry-canary.claudinite.com", CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret", PACKSERVER_ACCESS_HOST: "registry-canary.claudinite.com" },
      () => respond(),
    );
    await canary.driver.http.request({ surface: "web", method: "GET", path: "/x" });
    expect(canary.sent[0]!.headers["CF-Access-Client-Id"]).toBe("id");
  });

  it("fails the run on a response without the version header", async () => {
    const { driver } = driverWith({}, () => respond(null));
    await expect(driver.http.request({ surface: "web", method: "GET", path: "/" })).rejects.toThrow(/without X-PackServer-Version/);
  });

  it("fails the run on a response from a release other than the one expected", async () => {
    let release = "r1";
    const { driver } = driverWith({ PACKSERVER_VERSION_OVERRIDE: 'web="v"', PACKSERVER_EXPECTED_RELEASE: "r1" }, () => respond(release));
    await driver.http.request({ surface: "web", method: "GET", path: "/" });
    release = "r0";
    await expect(driver.http.request({ surface: "web", method: "GET", path: "/" })).rejects.toBeInstanceOf(InfrastructureError);
    expect([...driver.observedVersions()]).toEqual(["r1", "r0"]);
  });

  it("has no clock, fakes or recorder", async () => {
    const { driver } = driverWith({}, () => respond());
    expect([...driver.capabilities]).toEqual(["mcp"]);
    const world = createWorld(driver, "t");
    await expect(world.clock.advance("1h")).rejects.toThrow(/no clock/);
    await expect(world.recorder.invocations()).rejects.toThrow(/no recorder/);
    expect(() => world.mail.inbox({ email: "a@example.test" })).toThrow(/no mail fake/);
  });
});

describe("the http driver against a running system", () => {
  let harness: WorldHarness;
  let driver: HttpDriver;
  beforeAll(async () => {
    harness = createWorldHarness();
    const { url } = await harness.server.listen();
    driver = new HttpDriver(readHttpEnv({ PACKSERVER_BASE_URL: url.origin, PACKSERVER_EXPECTED_RELEASE: "unreleased" }));
    await driver.start();
  }, 120_000);
  afterAll(() => harness?.server.close());

  it("runs the smoke checks every driver must pass", async () => {
    await SMOKE.body(createWorld(driver, SMOKE.title));
  });
});
