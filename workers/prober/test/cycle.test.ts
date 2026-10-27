import { parseProbeAttrs } from "@packserver/core/gates";
import { CANDIDATE_MIRROR_KEY, type Clock } from "@packserver/ports";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { probeFacts } from "../../judge/src/stats/aggregate";
import { ROW_LIMIT } from "../../judge/src/stats/sql";
import { runCycle } from "../src/cycle";
import {
  candidateVersion, CANDIDATE_RELEASE, FakeRegistry, GATED, NOW, PACKS, PRODUCTION_RELEASE, productionVersion, REGISTRY, WORKERS, type Flaws,
} from "./fake-registry";

type Emitted = { signal: string; attrs: Record<string, string | number | boolean> };
type Kv = ReturnType<typeof createFakePorts>["kv"][string];

async function pass(flaws: Flaws = {}, options: { at?: number; candidate?: object | null; trusted?: boolean; kv?: Kv; before?: (kv: Kv) => Promise<void>; load?: () => void } = {}) {
  const registry = await FakeRegistry.create(flaws, options.trusted ?? true);
  await registry.publish();
  const kv = options.kv ?? createFakePorts({ worker: "prober" }).kv["TELEMETRY_KV"]!;
  if (options.candidate) await kv.put(CANDIDATE_MIRROR_KEY, JSON.stringify(options.candidate));
  await options.before?.(kv);
  const emitted: Emitted[] = [];
  const clock: Clock = { now: () => options.at ?? NOW };
  const result = await runCycle({
    load: async () => {
      options.load?.();
      return { config: registry.config, credentials: { access: { clientId: "id", clientSecret: "secret" }, selfTestKey: "hmac-key" } };
    },
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
  workers: Object.fromEntries([...WORKERS, "admin"].map((w) => [w, { changed: changed.includes(w), version_id: changed.includes(w) ? candidateVersion(w) : productionVersion(w) }])),
});

const failedScenarios = (emitted: Emitted[]): string[] => [...new Set(emitted.flatMap((e) => String(e.attrs.failed ?? "").split(",").filter(Boolean)))].sort();
const rowsOf = (emitted: Emitted[]) => emitted.map((e) => ({ attrs: JSON.stringify(e.attrs), n: 1, ts: NOW / 1000 }));

describe("the prober pass over production", () => {
  it("writes one summary row per version production is made of, in the shape the judge reads", async () => {
    const { emitted, result } = await pass();
    expect(result.ran).toBe(true);
    expect(emitted).toHaveLength(WORKERS.length);
    for (const e of emitted) {
      expect(e.signal).toBe("synthetic.probe");
      expect(e.attrs).toMatchObject({ scenario: "summary", ok: true, index_ok: true, stale_s: 0 });
      expect(e.attrs).not.toHaveProperty("failed");
      expect(parseProbeAttrs(JSON.stringify(e.attrs))).toMatchObject({ ok: true, indexOk: true, staleS: 0 });
    }
    expect(new Set(emitted.map((e) => e.attrs.target))).toEqual(new Set(WORKERS.map(productionVersion)));
    expect(new Set(emitted.map((e) => e.attrs.run)).size).toBe(1);
    const facts = probeFacts(rowsOf(emitted));
    expect([...facts.runs.keys()].sort()).toEqual(WORKERS.map(productionVersion).sort());
    expect([...facts.indexFetches.values()].every((f) => f.length === 1 && f[0]!.ok)).toBe(true);
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

  it("runs only on the five-minute marks when no release is in flight, and reads no configuration or secret in between", async () => {
    let loaded = 0;
    const quiet = await pass({}, { at: NOW + 3 * 60_000, load: () => void loaded++ });
    expect(quiet.result.ran).toBe(false);
    expect(loaded).toBe(0);
    expect(quiet.registry.requests).toEqual([]);
    expect(quiet.emitted).toEqual([]);
    const marked = await pass({}, { at: NOW + 5 * 60_000, load: () => void loaded++ });
    expect(marked.result.ran).toBe(true);
    expect(loaded).toBe(1);
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

describe("what makes a version's row fail", () => {
  const cases: Array<[string, Flaws, string[]]> = [
    ["a root signed by a key nobody trusts", { untrustedRoot: true }, ["update_check.signed_index"]],
    ["a root past its expiry", { rootAgeMs: 8 * 24 * 3_600_000 }, ["update_check.signed_index"]],
    ["a scope file whose serial is not the one the root recorded", { scopeSerialSkew: true }, ["update_check.signed_index"]],
    ["the canary listed with another hash", { listedHash: "f".repeat(64) }, ["update_check.signed_index"]],
    ["search without its semantic leg", { searchDegraded: true }, ["search.lexical_and_semantic"]],
    ["an archive that does not hash to the pin", { archiveBytes: new Uint8Array([9, 9]) }, ["adopt.public_pack"]],
    ["a sign-in that comes back signed in", { githubAnswers: 303 }, ["auth.github_signin_roundtrip"]],
    ["a sign-in GitHub refuses for wrong client credentials", { githubError: "incorrect_client_credentials" }, ["auth.github_signin_roundtrip"]],
    ["a sign-in that fails with no reason from GitHub", { githubError: "" }, ["auth.github_signin_roundtrip"]],
  ];
  it.each(cases)("%s fails that scenario on every version, and names it", async (_, flaws, scenarios) => {
    const { emitted } = await pass(flaws);
    expect(failedScenarios(emitted)).toEqual(scenarios);
    expect(emitted.every((e) => e.attrs.ok === false && e.attrs.failed === scenarios.join(","))).toBe(true);
    expect(emitted.every((e) => e.attrs.index_ok === !scenarios.includes("update_check.signed_index"))).toBe(true);
  });

  it("passes only a code GitHub refused as bad_verification_code", async () => {
    const { emitted } = await pass({ githubError: "bad_verification_code" });
    expect(emitted.every((e) => e.attrs.ok === true)).toBe(true);
  });

  it("fails the index scenario, and names why, when the registry's keys are not configured", async () => {
    const { emitted } = await pass({}, { trusted: false });
    expect(failedScenarios(emitted)).toEqual(["update_check.signed_index"]);
  });

  it("sees a root whose serial went backwards", async () => {
    const { emitted } = await pass({ rootSerial: 3 }, { before: (kv) => kv.put("prober/serial/root", "9") });
    expect(failedScenarios(emitted)).toEqual(["update_check.signed_index"]);
  });

  it("remembers the serials it verified and never lowers them", async () => {
    const { kv } = await pass();
    expect(await kv.get("prober/serial/root")).toBe("9");
    expect(await kv.get("prober/serial/scope:packserver-canary")).toBe("4");
    expect(await kv.get("prober/serial/keys")).toBe("2");
  });

  it("fails only the version whose self-test failed", async () => {
    const { emitted } = await pass({ selftestFails: "mcp" });
    expect(failedScenarios(emitted)).toEqual(["selftest"]);
    expect(emitted.filter((e) => e.attrs.ok === false).map((e) => e.attrs.target)).toEqual([productionVersion("mcp")]);
  });

  it("fails the version a Worker last answered as when its self-test then answers nothing usable", async () => {
    const shared = createFakePorts({ worker: "prober" }).kv["TELEMETRY_KV"]!;
    await pass({}, { kv: shared });
    const { emitted } = await pass({ selftestStatus: { web: 503 } }, { kv: shared });
    expect(emitted).toHaveLength(WORKERS.length);
    expect(emitted.filter((e) => e.attrs.ok === false).map((e) => [e.attrs.target, e.attrs.failed])).toEqual([[productionVersion("web"), "selftest"]]);
  });

  it("writes nothing for a Worker that has never answered, as there is no version to name", async () => {
    const { emitted } = await pass({ selftestStatus: { web: 503 } });
    expect(emitted).toHaveLength(WORKERS.length - 1);
  });
});

describe("the prober pass over a candidate", () => {
  it("pins the changed Workers through the gated host and writes the candidate's versions", async () => {
    const { registry, emitted, result } = await pass({}, { candidate: candidateRecord() });
    expect(result.targets.map((t) => t.target)).toEqual(["production", CANDIDATE_RELEASE]);
    expect(emitted.every((e) => e.attrs.ok === true)).toBe(true);
    const candidate = emitted.filter((e) => String(e.attrs.run).startsWith(CANDIDATE_RELEASE));
    expect(new Set(candidate.map((e) => e.attrs.target))).toEqual(new Set([candidateVersion("web"), candidateVersion("mcp")]));
    expect(candidate).toHaveLength(2);
    const pinned = registry.requests.filter((r) => r.headers["cloudflare-workers-version-overrides"]);
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
    expect(candidate).toHaveLength(2);
    expect(candidate.every((e) => e.attrs.ok === false)).toBe(true);
    expect(emitted.filter((e) => String(e.attrs.run).startsWith("production")).every((e) => e.attrs.ok === true)).toBe(true);
  });

  it("probes a candidate while it is rolled out and not before it is built or after it is live", async () => {
    for (const [state, probed] of [["building", false], ["verifying", true], ["rolling", true], ["live", false], ["rolled_back", false]] as const) {
      const { result } = await pass({}, { at: NOW + 3 * 60_000, candidate: candidateRecord(state) });
      expect(result.ran, state).toBe(probed);
    }
  });

  it("credits a Worker with no self-test only once another changed Worker's self-test proved the override reached the candidate", async () => {
    const { emitted } = await pass({}, { candidate: candidateRecord("verifying", ["web", "mcp", "admin"]) });
    const admin = emitted.filter((e) => e.attrs.target === candidateVersion("admin"));
    expect(admin).toHaveLength(1);
    expect(admin[0]!.attrs.ok).toBe(true);
  });

  it("writes nothing for a Worker with no self-test when nothing proved the candidate answered", async () => {
    // A release of admin alone: web and mcp answer as production, so the shared scenarios cannot be credited to the candidate.
    const { emitted } = await pass({}, { candidate: candidateRecord("verifying", ["admin"]) });
    expect(emitted.filter((e) => String(e.attrs.run).startsWith(CANDIDATE_RELEASE))).toEqual([]);
  });

  it("does not credit a forged record naming production's release for a version nobody can check", async () => {
    const forged = { release_id: PRODUCTION_RELEASE, state: "verifying", workers: { admin: { changed: true, version_id: "v-broken-candidate" } } };
    const { emitted } = await pass({}, { candidate: forged });
    expect(emitted.some((e) => e.attrs.target === "v-broken-candidate")).toBe(false);
  });

  it("does not let a forged record that names production's own web version confirm a broken admin", async () => {
    const forged = { release_id: PRODUCTION_RELEASE, state: "verifying", workers: { web: { changed: true, version_id: productionVersion("web") }, admin: { changed: true, version_id: "v-broken-candidate" } } };
    const { emitted } = await pass({}, { candidate: forged });
    expect(emitted.some((e) => e.attrs.target === "v-broken-candidate")).toBe(false);
  });

  it("still credits admin when web's candidate is a different version than the one serving", async () => {
    const { emitted } = await pass({}, { candidate: candidateRecord("verifying", ["web", "admin"]) });
    expect(emitted.filter((e) => e.attrs.target === candidateVersion("admin"))).toHaveLength(1);
  });

  it("believes no Worker name it does not know", async () => {
    const forged = { release_id: CANDIDATE_RELEASE, state: "verifying", workers: { "made-up": { changed: true, version_id: "v-forged" } } };
    const { emitted, result } = await pass({}, { at: NOW + 3 * 60_000, candidate: forged });
    expect(result.ran).toBe(false);
    expect(emitted).toEqual([]);
  });
});

describe("how many rows the judge has to read", () => {
  const rowsPerPass = async (candidate: object | null): Promise<number> => (await pass({}, { candidate })).emitted.length;

  it("keeps a day of steady state and a release hour under half of the judge's row limit", async () => {
    const steady = await rowsPerPass(null);
    const release = await rowsPerPass(candidateRecord("rolling", [...WORKERS]));
    const passesPerHour = 12;
    const perMinute = 60;
    const total = 23 * passesPerHour * steady + perMinute * release;
    expect(total).toBeLessThan(ROW_LIMIT / 2);
  });

  it("writes rows no two of which share their attributes within a day, so none is merged away", async () => {
    const first = await pass({}, { at: NOW });
    const second = await pass({}, { at: NOW + 5 * 60_000 });
    const keys = [...first.emitted, ...second.emitted].map((e) => JSON.stringify(e.attrs));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
