import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessDriver, stripCredentials } from "../drivers/inprocess";
import { InfrastructureError } from "../world/errors";

const driver = new InProcessDriver();

beforeAll(async () => {
  await driver.start();
  await driver.reset();
}, 120_000);
afterAll(() => driver.dispose());

interface Db {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): { all(): Promise<{ results: unknown[] }>; first<T>(): Promise<T | null> };
}

const users = async () => {
  const env = await driver.server.getWorker<{ DB: Db }>("web").getEnv();
  return env.DB;
};

describe("the in-process driver", () => {
  it("boots every workers/* directory", () => {
    expect([...driver.surfaces].sort()).toEqual(["admin", "github", "judge", "mcp", "prober", "publish", "validator", "web"]);
  });

  it("applies the registry migrations, and one reset wipes what a scenario wrote", async () => {
    const db = await users();
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").all();
    expect(tables.results).toHaveLength(1);
    await db.exec("INSERT INTO retired_names (kind, name, retired_at) VALUES ('scope', 'probe', '2026-01-01')");
    expect((await db.prepare("SELECT count(*) AS n FROM retired_names").first<{ n: number }>())?.n).toBe(1);
    await driver.reset();
    const after = await users();
    expect((await after.prepare("SELECT count(*) AS n FROM retired_names").first<{ n: number }>())?.n).toBe(0);
  });

  it("answers through the shared transport and records the version it saw", async () => {
    const res = await driver.http.request({ surface: "mcp", method: "GET", path: "/nowhere" });
    expect([res.status, res.headers.get("x-packserver-version")]).toEqual([404, "unreleased"]);
    expect(driver.observedVersions().has("unreleased")).toBe(true);
  });

  it("beginScenario returns the recorder, observed versions and logs to empty", async () => {
    await driver.http.request({ surface: "web", method: "GET", path: "/x" });
    expect(driver.observedVersions().size).toBe(1);
    await driver.beginScenario();
    expect(driver.observedVersions().size).toBe(0);
    expect(driver.recorder.invocations()).toEqual([]);
    expect(driver.server.getLogs()).toEqual([]);
    expect(driver.fakes.net.unfaked()).toEqual([]);
  });

  it("strips credentials from the logs it attaches to a failure", () => {
    const text = 'authorization: Bearer pks_abc123 cf-access-client-secret="s3cr3t" cookie=sid=1 token eyJhbGciOi.eyJzdWIi.sig plain';
    const out = stripCredentials(text);
    for (const leaked of ["pks_abc123", "s3cr3t", "sid=1", "eyJhbGciOi"]) expect(out).not.toContain(leaked);
    expect(out).toContain("plain");
  });

  it("refuses to address a Worker that is not booted", async () => {
    await expect(driver.http.request({ surface: "ghost" as never, method: "GET", path: "/" })).rejects.toBeInstanceOf(InfrastructureError);
  });
});
