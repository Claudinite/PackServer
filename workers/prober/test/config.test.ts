import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, parseTrustedKeys, readConfig, CANARY_PACK, CANARY_VERSION } from "../src/config";
import { SELFTEST_PATHS } from "../src/probes/selftest";
import { overrideHeader, readCandidate } from "../src/targets";
import { createFakePorts } from "@packserver/ports/fakes";
import { CANDIDATE_MIRROR_KEY } from "@packserver/ports";

// The release tooling is plain Node modules without declarations; a computed specifier keeps them untyped here.
const tool = <T>(path: string): Promise<T> => import(pathToFileURL(join(import.meta.dirname, "..", "..", "..", path)).href) as Promise<T>;

const secrets = { accessToken: async () => ({ clientId: "i", clientSecret: "s" }), selfTestKey: async () => "k" };
const vars = { REGISTRY_ORIGIN: "https://r.test", PACKS_ORIGIN: "https://p.test", GATED_ORIGIN: "https://g.test", CANARY_PACK_SHA256: "a".repeat(64) };
const wrangler = JSON.parse(readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8")) as {
  env: Record<string, { vars: Record<string, string>; triggers?: { crons: string[] } }>;
};

describe("the probing configuration", () => {
  it("refuses a missing or malformed origin or pin instead of probing a guess", () => {
    for (const missing of Object.keys(vars)) expect(() => readConfig({ ...vars, [missing]: undefined }, secrets), missing).toThrow(ConfigError);
    expect(() => readConfig({ ...vars, REGISTRY_ORIGIN: "http://r.test" }, secrets)).toThrow(/https origin/);
    expect(() => readConfig({ ...vars, PACKS_ORIGIN: "https://p.test/index" }, secrets)).toThrow(/https origin/);
    expect(() => readConfig({ ...vars, CANARY_PACK_SHA256: "abc" }, secrets)).toThrow(/SHA-256/);
  });

  it("keeps an unset key list as unknown and refuses a malformed one", () => {
    expect(readConfig(vars, secrets).trustedKeys).toBeNull();
    expect(parseTrustedKeys("")).toBeNull();
    expect(() => parseTrustedKeys("[]")).toThrow(ConfigError);
    expect(() => parseTrustedKeys("nope")).toThrow(/not JSON/);
    expect(() => parseTrustedKeys('[{"kid":"k"}]')).toThrow(ConfigError);
    expect(parseTrustedKeys('[{"kid":"2026-10","public_key":"abc","status":"active"}]')).toHaveLength(1);
  });

  // The pin is the hash of the fixture the owner publishes; the fixture's own definition is in tools/canary.
  it("pins every deployed environment to the hash of the fixture the canary publisher builds", async () => {
    const { FIXTURES, packFixture } = await tool<{ FIXTURES: Array<{ pack: string; version: string }>; packFixture(fixture: unknown): Promise<{ sha256: string }> }>("tools/canary/publish-canary.mjs");
    const fixture = FIXTURES.find((f) => f.pack === CANARY_PACK);
    expect(fixture?.version).toBe(CANARY_VERSION);
    const { sha256 } = await packFixture(fixture);
    for (const env of ["staging", "production"]) expect(wrangler.env[env]!.vars.CANARY_PACK_SHA256, env).toBe(sha256);
  });

  it("lists the self-tests the release tooling verifies, less the Worker that has a host of its own", async () => {
    const { WORKERS: RELEASE_WORKERS } = await tool<{ WORKERS: Array<{ name: string; selftest: string; host?: string }> }>("tools/release/common.mjs");
    const released = RELEASE_WORKERS.filter((w) => !w.host).map((w) => [w.name, w.selftest]);
    expect(Object.entries(SELFTEST_PATHS).sort()).toEqual(released.sort());
  });

  it("runs every minute and decides itself which passes are due", () => {
    for (const env of ["staging", "production"]) expect(wrangler.env[env]!.triggers?.crons, env).toEqual(["* * * * *"]);
  });
});

describe("the candidate the release tooling mirrors", () => {
  const kv = () => createFakePorts({ worker: "prober" }).kv["TELEMETRY_KV"]!;
  const record = (workers: object, state = "verifying") => JSON.stringify({ release_id: "rel-1", state, workers });

  it("reads the changed Workers of a release being verified", async () => {
    const store = kv();
    await store.put(CANDIDATE_MIRROR_KEY, record({ web: { changed: true, version_id: "abc-123" }, mcp: { changed: false, version_id: "old" } }));
    const candidate = await readCandidate(store);
    expect(candidate).toEqual({ releaseId: "rel-1", changed: { web: "abc-123" } });
    expect(overrideHeader(candidate!)).toBe('web="abc-123"');
  });

  it.each([
    ["nothing mirrored", null],
    ["not JSON", "{"],
    ["no workers", JSON.stringify({ release_id: "r", state: "verifying" })],
    ["nothing changed", record({ web: { changed: false, version_id: "v" } })],
    ["a release past verification", record({ web: { changed: true, version_id: "v" } }, "live")],
  ])("probes no candidate when %s", async (_, raw) => {
    const store = kv();
    if (raw !== null) await store.put(CANDIDATE_MIRROR_KEY, raw);
    expect(await readCandidate(store)).toBeNull();
  });

  it("drops a name or version that could not be written into a header safely", async () => {
    const store = kv();
    await store.put(CANDIDATE_MIRROR_KEY, record({ web: { changed: true, version_id: 'x", admin="y' }, 'a"b': { changed: true, version_id: "ok" }, mcp: { changed: true, version_id: "good-1" } }));
    expect((await readCandidate(store))?.changed).toEqual({ mcp: "good-1" });
  });
});
