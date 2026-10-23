import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt, createGithubReader, fetchSourceTree, TREE_LIMITS } from "../index.ts";
import { buildTree, treeHash } from "../../canonical/tree.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8Pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pkcs1Pem = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const bareBase64 = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

describe("App identity token", () => {
  it.each([
    ["PKCS#8 PEM", pkcs8Pem],
    ["PKCS#1 PEM as GitHub issues it", pkcs1Pem],
    ["bare base64 PKCS#8", bareBase64],
  ])("signs with a %s key", async (_name, privateKey) => {
    const jwt = await appJwt({ appId: "42", privateKey, nowMs: 1_800_000_000_000 });
    const [head, payload, sig] = jwt.split(".") as [string, string, string];
    expect(verify("sha256", Buffer.from(`${head}.${payload}`), createPublicKey(createPrivateKey(pkcs8Pem)), Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_480, iss: "42" });
  });
});

interface Blob {
  mode?: string;
  content: string;
}
interface World {
  files: Record<string, Blob>;
  private?: boolean;
  fail?: number;
}

/** A GitHub that serves one repository and records every request. */
function githubFor(world: World) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 2));
    init.signal?.throwIfAborted();
    const { pathname, search } = new URL(url);
    calls.push(`${init.method} ${pathname}${search}`);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (world.fail) return json({}, world.fail);
    if (pathname === "/app/installations") return json([{ id: 5 }]);
    if (pathname === "/app/installations/5/access_tokens") return json({ token: "ghs_x" });
    if (pathname === "/repositories/501") return json({ id: 501, full_name: "acme/packs", default_branch: "main", private: !!world.private, archived: false });
    if (pathname.startsWith("/repos/acme/packs/git/trees/")) {
      const tree = Object.entries(world.files).map(([path, f]) => ({ path, mode: f.mode ?? "100644", type: "blob", sha: `sha-${path}`, size: f.content.length }));
      return json({ tree, truncated: false });
    }
    const blob = /\/git\/blobs\/sha-(.+)$/.exec(pathname);
    if (blob) return new Response(world.files[decodeURIComponent(blob[1]!)]!.content);
    return json({}, 404);
  }) as unknown as typeof fetch;
  const make = (signal?: AbortSignal) => createGithubReader({ ...(signal ? { signal } : {}), fetch: fetchFn, appId: "42", privateKey: bareBase64, nowMs: () => 1_800_000_000_000 });
  return { calls, make };
}
const COMMIT = "a".repeat(40);

describe("source tree fetch (IT-PUB-006, fetch half)", () => {
  it("hashes the regular files under the path, relative to it, and writes nothing", async () => {
    const g = githubFor({ files: { "packs/gcp/pack.json": { content: "{}" }, "packs/gcp/run.sh": { content: "#!/bin/sh", mode: "100755" }, "packs/other/x": { content: "no" }, "README.md": { content: "r" } } });
    const result = await fetchSourceTree(g.make, { repository_id: 501, commit: COMMIT, path: "packs/gcp" });
    const expected = treeHash(buildTree([
      { path: "pack.json", executable: false, content: new TextEncoder().encode("{}") },
      { path: "run.sh", executable: true, content: new TextEncoder().encode("#!/bin/sh") },
    ]));
    expect(result).toEqual({ status: "found", tree_hash: expected, file_count: 2 });
    expect(g.calls.filter((c) => !c.startsWith("GET "))).toEqual(["POST /app/installations/5/access_tokens"]);
    expect(g.calls.filter((c) => c.includes("access_tokens"))).toHaveLength(1);
  });

  it.each([
    ["a private repository", { files: { "p/a": { content: "x" } }, private: true }, "p"],
    ["a path with nothing under it", { files: { "p/a": { content: "x" } } }, "q"],
    ["a path that climbs out", { files: { "p/a": { content: "x" } } }, "../p"],
    ["a symlink", { files: { "p/a": { content: "x", mode: "120000" } } }, "p"],
    ["a submodule", { files: { "p/a": { content: "x", mode: "160000" } } }, "p"],
  ])("answers not_found for %s", async (_name, world, path) => {
    const g = githubFor(world as World);
    expect(await fetchSourceTree(g.make, { repository_id: 501, commit: COMMIT, path })).toEqual({ status: "not_found" });
    expect(g.calls.filter((c) => c.includes("/git/blobs/"))).toEqual([]);
  });

  it("refuses to fetch blobs for a tree over the file, byte or count limits", async () => {
    const many = Object.fromEntries(Array.from({ length: TREE_LIMITS.files + 1 }, (_, i) => [`p/${i}`, { content: "x" }]));
    const g = githubFor({ files: many });
    expect(await fetchSourceTree(g.make, { repository_id: 501, commit: COMMIT, path: "p" })).toEqual({ status: "not_found" });
    expect(g.calls.filter((c) => c.includes("/git/blobs/"))).toEqual([]);

    const big = githubFor({ files: { "p/a": { content: "x".repeat(10) } } });
    expect(await fetchSourceTree(big.make, { repository_id: 501, commit: COMMIT, path: "p" }, { ...TREE_LIMITS, fileBytes: 5 })).toEqual({ status: "not_found" });
    expect(await fetchSourceTree(big.make, { repository_id: 501, commit: COMMIT, path: "p" }, { ...TREE_LIMITS, totalBytes: 5 })).toEqual({ status: "not_found" });
  });

  it("says unreachable, not not_found, when GitHub fails or is rate limited", async () => {
    expect(await fetchSourceTree(githubFor({ files: {}, fail: 503 }).make, { repository_id: 501, commit: COMMIT, path: "p" })).toEqual({ status: "unreachable", retry_after_s: TREE_LIMITS.retryAfterS });
    const timedOut = githubFor({ files: { "p/a": { content: "x" } } });
    const result = await fetchSourceTree(timedOut.make, { repository_id: 501, commit: COMMIT, path: "p" }, { ...TREE_LIMITS, deadlineMs: 0 });
    expect(result.status).toBe("unreachable");
  });
});
