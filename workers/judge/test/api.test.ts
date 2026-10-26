import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { evaluateGates } from "../src/gates/cycle";
import { gatesStore } from "../src/gates/store";
import { FakeGateData, group, judgeFakes, runtimeWith } from "./support";

/** Response bodies are JSON the tests inspect by field. */
const json = async (response: Response): Promise<any> => response.json(); // eslint-disable-line @typescript-eslint/no-explicit-any -- ad-hoc inspection of test responses

async function setup() {
  const fakes = judgeFakes();
  const data = new FakeGateData();
  const gatesKv = fakes.kv["GATES_KV"] as NonNullable<(typeof fakes.kv)[string]>;
  const app = createApp(runtimeWith(fakes, data));
  const token = await fakes.access.assert({ email: "probe@packserver.test", sub: "service-token" });
  const get = (path: string, headers: Record<string, string> = { "cf-access-jwt-assertion": token }) => app.request(path, { headers });
  const post = (body: unknown, headers: Record<string, string> = { "cf-access-jwt-assertion": token }) =>
    app.request("/probe-results", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { fakes, data, gatesKv, get, post };
}

describe("GET /gates", () => {
  it("answers nothing without a verified Access assertion", async () => {
    const { get } = await setup();
    expect((await get("/gates/v1", {})).status).toBe(401);
    expect((await get("/gates/v1", { "cf-access-jwt-assertion": "forged|x|y" })).status).toBe(401);
  });

  it("returns the version's report and a single gate", async () => {
    const { fakes, data, gatesKv, get } = await setup();
    data.groups = [group("web-new", "web", 400)];
    await evaluateGates({ clock: fakes.clock, gatesKv, data, stats: fakes.stats }, null, "launch");
    const report = await json(await get("/gates/web-new"));
    expect(report).toMatchObject({ version_id: "web-new", worker: "web", mode: "launch" });
    expect(report.gates["gate.availability"].status).toBe("pass");
    const one = await get("/gates/web-new/gate.availability");
    expect(one.headers.get("cache-control")).toBe("no-store");
    expect(await one.json()).toMatchObject({ gate: "gate.availability", status: "pass", version_id: "web-new" });
  });

  it("separates an unknown version, an unknown gate and a gate the Worker does not carry", async () => {
    const { fakes, data, gatesKv, get } = await setup();
    data.groups = [group("admin-1", "admin", 400)];
    await evaluateGates({ clock: fakes.clock, gatesKv, data, stats: fakes.stats }, null, "launch");
    expect((await get("/gates/nope")).status).toBe(404);
    expect(await json(await get("/gates/admin-1/gate.nonsense"))).toMatchObject({ error: "unknown_gate" });
    expect(await json(await get("/gates/admin-1/gate.domain.hash_integrity"))).toMatchObject({ error: "gate_not_carried" });
  });

  it("decides a stage's proportion gates on demand without spending a decision point", async () => {
    const { fakes, data, gatesKv, get } = await setup();
    const deps = { clock: fakes.clock, gatesKv, data, stats: fakes.stats };
    data.groups = [group("web-new", "web", 300, 0, { recent: 2000 })];
    await evaluateGates(deps, null, "launch");
    data.groups = [group("web-new", "web", 450, 40, { recent: 2000 })];
    await evaluateGates(deps, null, "launch");
    expect((await json(await get("/gates/web-new/gate.availability"))).status).toBe("watching");
    const end = await json(await get("/gates/web-new/gate.availability?stage_end=1"));
    expect(end.status).toBe("fail");
    expect((await json(await get("/gates/web-new/gate.availability"))).status).toBe("watching");
    expect((await gatesStore(gatesKv).memory("web-new"))["gate.availability"]?.decided_at).toBe(300);
  });
});

describe("POST /probe-results", () => {
  const result = { kind: "publish.dry_run", version_id: "pub-new", run_id: "run-1", reached_verdict: true, publish_failed: false };

  it("needs Access", async () => {
    const { post } = await setup();
    expect((await post(result, {})).status).toBe(401);
  });

  it("records a dry run once and feeds the publish gate", async () => {
    const { fakes, data, gatesKv, post, get } = await setup();
    expect((await post(result)).status).toBe(202);
    const again = await post(result);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, recorded: false });
    expect(await gatesStore(gatesKv).dryRuns("pub-new")).toHaveLength(1);
    data.groups = [group("pub-new", "publish", 10)];
    await evaluateGates({ clock: fakes.clock, gatesKv, data, stats: fakes.stats }, null, "launch");
    expect((await json(await get("/gates/pub-new/gate.domain.publish_success"))).status).toBe("pass");
  });

  it("turns a dry run that raised publish.failed into a failed gate", async () => {
    const { fakes, data, gatesKv, post, get } = await setup();
    await post({ ...result, publish_failed: true });
    data.groups = [group("pub-new", "publish", 10)];
    await evaluateGates({ clock: fakes.clock, gatesKv, data, stats: fakes.stats }, null, "launch");
    expect((await json(await get("/gates/pub-new/gate.domain.publish_success"))).status).toBe("fail");
  });

  it("refuses a malformed, unknown-kind or oversized body", async () => {
    const { post } = await setup();
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...result, kind: "something.else" })).status).toBe(400);
    expect((await post({ ...result, reached_verdict: "yes" })).status).toBe(400);
    expect((await post({ ...result, run_id: "x".repeat(3000) })).status).toBe(413);
  });
});
