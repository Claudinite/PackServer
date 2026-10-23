import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeRelease, writeMirror } from "../../fixtures/load-run/index.ts";
import { fetchRelease, httpMirror, MirrorError, readManifest, selectEngines, type MirrorManifest } from "../b-mirror.ts";
import { dirMirror, prepareInput } from "../b-prepare.ts";

let root: string;
let sha: Record<string, string>;
let manifest: MirrorManifest;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "b-mirror-"));
  sha = writeMirror(root, ["1.61001.1", "1.61003.0", "1.61004.1"]).sha256;
  manifest = await readManifest(dirMirror(root));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("fetching a release from the mirror (IT-VAL-032)", () => {
  it("returns the bytes of a release that hashes to its pin", async () => {
    const bytes = await fetchRelease(dirMirror(root), manifest, "1.61004.1", sha["1.61004.1"]!);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("refuses a pin the manifest does not list", async () => {
    await expect(fetchRelease(dirMirror(root), manifest, "1.61004.1", "0".repeat(64))).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("refuses a tarball that does not hash to the pin, even when manifest and sidecar agree on the pin", async () => {
    await writeFile(join(root, "cn-releases", "1.61003.0.tgz"), "tampered");
    await expect(fetchRelease(dirMirror(root), manifest, "1.61003.0", sha["1.61003.0"]!)).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("refuses a sidecar that disagrees with the pin", async () => {
    await writeFile(join(root, "cn-releases", "1.61001.1.sha256"), "f".repeat(64));
    await expect(fetchRelease(dirMirror(root), manifest, "1.61001.1", sha["1.61001.1"]!)).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("names a release the manifest does not know, and one whose object is missing", async () => {
    await expect(fetchRelease(dirMirror(root), manifest, "9.9.9", "a".repeat(64))).rejects.toMatchObject({ code: "version_unknown" });
    const empty = await mkdtemp(join(tmpdir(), "b-mirror-empty-"));
    await expect(readManifest(dirMirror(empty))).rejects.toBeInstanceOf(MirrorError);
    await rm(empty, { recursive: true });
  });

  it("reads over HTTP, treating 404 as absent", async () => {
    const release = fakeRelease("1.61004.1");
    const calls: string[] = [];
    const fake = (async (url: URL | string) => {
      calls.push(String(url));
      return String(url).endsWith(".tgz") ? new Response(release.tgz as Uint8Array<ArrayBuffer>) : new Response("", { status: 404 });
    }) as typeof fetch;
    const mirror = httpMirror("https://mirror.example/ops", fake);
    expect(await mirror.get("cn-releases/x.sha256")).toBeNull();
    expect((await mirror.get("cn-releases/1.61004.1.tgz"))?.length).toBe(release.tgz.length);
    expect(calls[1]).toBe("https://mirror.example/ops/cn-releases/1.61004.1.tgz");
  });
});

describe("choosing the two engines", () => {
  it("takes the oldest release that satisfies the minimum, up to the pinned newest", () => {
    expect(selectEngines(manifest, "1.61004.1", "1.61002.0")).toEqual({ newest: "1.61004.1", lowest: "1.61003.0", supported: true });
    expect(selectEngines(manifest, "1.61004.1", "1.61001.1")).toMatchObject({ lowest: "1.61001.1", supported: true });
  });

  it("contrast: a minimum older than the mirror's oldest is unsupported", () => {
    expect(selectEngines(manifest, "1.61004.1", "1.61000.9").supported).toBe(false);
  });

  it("a minimum newer than everything loads on the newest only", () => {
    expect(selectEngines(manifest, "1.61004.1", "1.70000.0")).toMatchObject({ lowest: "1.61004.1", supported: true });
  });
});

describe("handing the engines in (IT-VAL-032)", () => {
  let fresh: string;
  let sha: Record<string, string>;
  beforeAll(async () => {
    fresh = await mkdtemp(join(tmpdir(), "b-prep-mirror-"));
    sha = writeMirror(fresh, ["1.61001.1", "1.61004.1"]).sha256;
  });
  afterAll(() => rm(fresh, { recursive: true, force: true }));
  const options = (digests: Record<string, string>) => ({ mirror: dirMirror(fresh), pack: "@acme/gcp", canonical: new Uint8Array(), expectedTreeHash: "a".repeat(64), minEngineVersion: "1.61001.1", newest: "1.61004.1", digests });

  it("fetches both engines against digests the registry pinned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b-prep-"));
    const request = await prepareInput({ ...options(sha), dir });
    expect(request.engines.map((e) => e.version)).toEqual(["1.61004.1", "1.61001.1"]);
  });

  it("never takes the lowest engine's digest from the manifest alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b-prep-"));
    await expect(prepareInput({ ...options({ "1.61004.1": sha["1.61004.1"]! }), dir })).rejects.toMatchObject({ code: "digest_unpinned" });
  });

  it("refuses a pin the manifest contradicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b-prep-"));
    await expect(prepareInput({ ...options({ ...sha, "1.61001.1": "0".repeat(64) }), dir })).rejects.toMatchObject({ code: "digest_mismatch" });
  });
});
