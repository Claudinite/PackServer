import { INDEX_SCENARIO, parseProbeAttrs } from "@packserver/core/gates";
import { CANDIDATE_MIRROR_KEY, type Clock } from "@packserver/ports";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { runCycle, SHARED_SCENARIOS } from "../src/cycle";
import {
  candidateVersion, CANDIDATE_RELEASE, FakeRegistry, GATED, NOW, PACKS, productionVersion, REGISTRY, WORKERS, type Flaws,
} from "./fake-registry";

type Emitted = { signal: string; attrs: Record<string, string | number | boolean> };

async function pass(flaws: Flaws = {}, options: { at?: number; candidate?: object | null; trusted?: boolean; before?: (kv: ReturnType<typeof createFakePorts>["kv"][string]) => Promise<void> } = {}) {
  const registry = await FakeRegistry.create(flaws, options.trusted ?? true);
  await registry.publish();
  const kv = createFakePorts({ worker: "prober" }).kv["TELEMETRY_KV"]!;
  if (options.candidate) await kv.put(CANDIDATE_MIRROR_KEY, JSON.stringify(options.candidate));
  await options.before?.(kv);
  const emitted: Emitted[] = [];
  const clock: Clock = { now: () => options.at ?? NOW };
  const result = await runCycle({
    config: registry.config,
    credentials: { access: { clientId: "id", clientSecret: "secret" }, selfTestKey: "hmac-key" },
    clock,
    kv,
    fetch: registry.fetch as typeof fetch,
    emit: (signal, attrs) => void emitted.push({ signal, attrs: attrs as Emitted["attrs"] }),
  });
  return { registry, kv, emitted, result };
}

const candidateRecord = (state = "verifying", changed: string[] = ["web", "mcp"]) => ({
  release_id: CANDIDATE_RELEASE,
  state,
  workers: Object.fromEntries(WORKERS.map((w) => [w, { changed: changed.includes(w), version_id: changed.includes(w) ? candidateVersion(w) : productionVersion(w) }])),
});

const failing = (emitted: Emitted[]): string[] => [...new Set(emitted.filter((e) => e.attrs.ok === false).map((e) => String(e.attrs.scenario)))].sort();

describe("the prober pass over production", () => {
  it("writes every scenario once per version production is made of, in the shape the judge reads", async () => {
    const { emitted, result } = await pass();
    expect(result.ran).toBe(true);
    expect(failing(emitted)).toEqual([]);
    expect(emitted).toHaveLength(WORKERS.length * (SHARED_SCENARIOS.length + 1));
    for (const e of emitted) {
      expect(e.signal).toBe("synthetic.probe");
      const parsed = parseProbeAttrs(JSON.stringify(e.attrs));
      expect(parsed, JSON.stringify(e.attrs)).not.toBeNull();
      expect(parsed!.target).toMatch(/^v-.*-prod$/);
    }
    expect(new Set(emitted.map((e) => e.attrs.target))).toEqual(new Set(WORKERS.map(productionVersion)));
    expect(new Set(emitted.map((e) => e.attrs.run)).size).toBe(1);
    const index = emitted.find((e) => e.attrs.scenario === INDEX_SCENARIO)!;
    expect(parseProbeAttrs(JSON.stringify(index.attrs))!.staleS).toBe(0);
    expect(emitted.filter((e) => e.attrs.scenario !== INDEX_SCENARIO).every((e) => !("stale_s" in e.attrs))).toBe(true);
  });

  it("asks the registry as a visitor and sends the Access token to the gated host alone", async () => {
    const { registry } = await pass();
    const visitor = registry.requests.filter((r) => r.url.startsWith(REGISTRY) || r.url.startsWith(PACKS));
    expect(visitor.length).toBeGreaterThan(0);
    for (const r of visitor) {
      expect(Object.keys(r.headers).filter((h) => h.startsWith("cf-access") || h === "x-selftest-signature" || h === "cloudflare-workers-version-overrides")).toEqual([]);
    }
    const gated = registry.requests.filter((r) => r.url.startsWith(GATED));
    expect(gated).toHaveLength(WORKERS.length);
    expect(gated.every((r) => r.url.includes("__selftest"))).toBe(true);
    for (const r of gated) expect(r.headers).toMatchObject({ "cf-access-client-id": "id", "cf-access-client-secret": "secret" });
    expect(gated.every((r) => r.headers["x-selftest-signature"]?.includes("k=prober"))).toBe(true);
  });

  it("runs only on the five-minute marks when no release is in flight", async () => {
    const quiet = await pass({}, { at: NOW + 3 * 60_000 });
    expect(quiet.result.ran).toBe(false);
    expect(quiet.registry.requests).toEqual([]);
    expect(quiet.emitted).toEqual([]);
    const marked = await pass({}, { at: NOW + 5 * 60_000 });
    expect(marked.result.ran).toBe(true);
  });

  it("asks a full self-test on the mark and a shallow one between", async () => {
    const mark = await pass({}, { at: NOW + 5 * 60_000 });
    expect(mark.registry.requests.filter((r) => r.url.startsWith(GATED) && r.url.includes("__selftest")).some((r) => r.url.includes("shallow"))).toBe(false);
    const between = await pass({}, { at: NOW + 3 * 60_000, candidate: candidateRecord() });
    const selfTests = between.registry.requests.filter((r) => r.url.startsWith(GATED) && r.url.includes("__selftest"));
    expect(selfTests.length).toBeGreaterThan(0);
    expect(selfTests.every((r) => r.url.includes("shallow=1"))).toBe(true);
  });
});

describe("what makes a scenario fail", () => {
  const cases: Array<[string, Flaws, string[]]> = [
    ["a root signed by a key nobody trusts", { untrustedRoot: true }, [INDEX_SCENARIO]],
    ["a root past its expiry", { rootAgeMs: 8 * 24 * 3_600_000 }, [INDEX_SCENARIO]],
    ["a scope file whose serial is not the one the root recorded", { scopeSerialSkew: true }, [INDEX_SCENARIO]],
    ["the canary listed with another hash", { listedHash: "f".repeat(64) }, [INDEX_SCENARIO]],
    ["search without its semantic leg", { searchDegraded: true }, ["search.lexical_and_semantic"]],
    ["an archive that does not hash to the pin", { archiveBytes: new Uint8Array([9, 9]) }, ["adopt.public_pack"]],
    ["a sign-in that comes back signed in", { githubAnswers: 303 }, ["auth.github_signin_roundtrip"]],
  ];
  it.each(cases)("%s fails that scenario alone, on every version", async (_, flaws, scenarios) => {
    const { emitted } = await pass(flaws);
    expect(failing(emitted)).toEqual(scenarios);
    for (const scenario of scenarios) expect(emitted.filter((e) => e.attrs.scenario === scenario).every((e) => e.attrs.ok === false)).toBe(true);
  });

  it("fails the index scenario, and names why, when the registry's keys are not configured", async () => {
    const { emitted } = await pass({}, { trusted: false });
    expect(failing(emitted)).toEqual([INDEX_SCENARIO]);
  });

  it("sees a root whose serial went backwards", async () => {
    const { emitted } = await pass({ rootSerial: 3 }, { before: (kv) => kv.put("prober/serial/root", "9") });
    expect(failing(emitted)).toEqual([INDEX_SCENARIO]);
  });

  it("remembers the serials it verified and never lowers them", async () => {
    const { kv } = await pass();
    expect(await kv.get("prober/serial/root")).toBe("9");
    expect(await kv.get("prober/serial/scope:packserver-canary")).toBe("4");
    expect(await kv.get("prober/serial/keys")).toBe("2");
  });

  it("fails only the version whose self-test failed", async () => {
    const { emitted } = await pass({ selftestFails: "mcp" });
    expect(failing(emitted)).toEqual([`selftest.${productionVersion("mcp")}`]);
    expect(emitted.filter((e) => e.attrs.ok === false)).toHaveLength(1);
  });
});

describe("the prober pass over a candidate", () => {
  it("pins the changed Workers through the gated host and writes the candidate's versions", async () => {
    const { registry, emitted, result } = await pass({}, { candidate: candidateRecord() });
    expect(result.targets.map((t) => t.target)).toEqual(["production", CANDIDATE_RELEASE]);
    expect(failing(emitted)).toEqual([]);
    const candidate = emitted.filter((e) => String(e.attrs.run).startsWith(CANDIDATE_RELEASE));
    expect(new Set(candidate.map((e) => e.attrs.target))).toEqual(new Set([candidateVersion("web"), candidateVersion("mcp")]));
    expect(candidate).toHaveLength(2 * (SHARED_SCENARIOS.length + 1));
    const pinned = registry.requests.filter((r) => r.headers["cloudflare-workers-version-overrides"]);
    expect(pinned.length).toBeGreaterThan(0);
    expect(new Set(pinned.map((r) => r.headers["cloudflare-workers-version-overrides"]))).toEqual(new Set([`mcp="${candidateVersion("mcp")}", web="${candidateVersion("web")}"`]));
    expect(pinned.every((r) => r.url.startsWith(GATED))).toBe(true);
  });

  it("reaches only the changed Workers' self-tests", async () => {
    const { registry } = await pass({}, { candidate: candidateRecord() });
    const pinned = registry.requests.filter((r) => r.headers["cloudflare-workers-version-overrides"] && r.url.includes("__selftest"));
    expect(pinned.map((r) => new URL(r.url).pathname).sort()).toEqual(["/__selftest", "/mcp/__selftest"]);
  });

  it("fails the candidate when the override was ignored, and leaves production's record alone", async () => {
    const { emitted } = await pass({ ignoreOverride: true }, { candidate: candidateRecord() });
    const candidate = emitted.filter((e) => String(e.attrs.run).startsWith(CANDIDATE_RELEASE));
    expect(candidate.length).toBeGreaterThan(0);
    expect(candidate.every((e) => e.attrs.ok === false || e.attrs.scenario === INDEX_SCENARIO)).toBe(true);
    expect(emitted.filter((e) => String(e.attrs.run).startsWith("production")).every((e) => e.attrs.ok === true)).toBe(true);
  });

  it("probes a candidate while it is rolled out and not before it is built or after it is live", async () => {
    for (const [state, probed] of [["building", false], ["verifying", true], ["rolling", true], ["live", false], ["rolled_back", false]] as const) {
      const { result } = await pass({}, { at: NOW + 3 * 60_000, candidate: candidateRecord(state) });
      expect(result.ran, state).toBe(probed);
    }
  });

  it("judges a Worker with no self-test on the gated host by the shared scenarios alone", async () => {
    const { emitted } = await pass({}, { candidate: { ...candidateRecord("verifying", ["admin"]), workers: { admin: { changed: true, version_id: "v-admin-next" } } } });
    const admin = emitted.filter((e) => e.attrs.target === "v-admin-next");
    expect(admin).toHaveLength(SHARED_SCENARIOS.length);
    expect(admin.some((e) => String(e.attrs.scenario).startsWith("selftest."))).toBe(false);
  });
});
