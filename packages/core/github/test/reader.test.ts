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
  installs?: Array<{ id: number; account: { login: string }; suspended_at: string | null }>;
  blobFail?: boolean;
}

/** A GitHub that serves one repository and records every request. */
function githubFor(world: World) {
  const calls: string[] = [];
  const bodies: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 2));
    init.signal?.throwIfAborted();
    const { pathname, search } = new URL(url);
    calls.push(`${init.method} ${pathname}${search}`);
    if (init.body) bodies.push(String(init.body));
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (world.fail) return json({}, world.fail);
    if (pathname === "/app/installations") return json(world.installs ?? [{ id: 5, account: { login: "acme" }, suspended_at: null }]);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (mint) return json({ token: `ghs_${mint[1]}` });
    if (pathname === "/repositories/501") return json({ id: 501, full_name: "acme/packs", default_branch: "main", private: !!world.private, archived: false });
    if (pathname.startsWith("/repos/acme/packs/git/trees/")) {
      const tree = Object.entries(world.files).map(([path, f]) => ({ path, mode: f.mode ?? "100644", type: (f.mode ?? "") === "160000" ? "commit" : "blob", sha: `sha-${path}`, size: f.content.length }));
      return json({ tree, truncated: false });
    }
    const blob = /\/git\/blobs\/sha-(.+)$/.exec(pathname);
    if (blob && world.blobFail) return json({}, 503);
    if (blob) return new Response(world.files[decodeURIComponent(blob[1]!)]!.content);
    return json({}, 404);
  }) as unknown as typeof fetch;
  const make = (signal?: AbortSignal) => createGithubReader({ ...(signal ? { signal } : {}), fetch: fetchFn, appId: "42", privateKey: bareBase64, nowMs: () => 1_800_000_000_000 });
  return { calls, bodies, make };
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
    ["a submodule", { files: { "p/a": { content: "x", mode: "160000" }, "p/b": { content: "y" } } }, "p"],
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

  it("reads through the repository owner's installation, skips a suspended one, and asks for read permissions only", async () => {
    const g = githubFor({
      files: { "p/a": { content: "x" } },
      installs: [
        { id: 1, account: { login: "other" }, suspended_at: null },
        { id: 2, account: { login: "acme" }, suspended_at: "2026-10-01T00:00:00Z" },
        { id: 3, account: { login: "ACME" }, suspended_at: null },
      ],
    });
    expect((await fetchSourceTree(g.make, { repository_id: 501, commit: COMMIT, path: "p" })).status).toBe("found");
    const minted = g.calls.filter((c) => c.startsWith("POST"));
    expect(minted).toEqual(["POST /app/installations/1/access_tokens", "POST /app/installations/3/access_tokens"]);
    expect(g.bodies.map((b) => JSON.parse(b))).toEqual(Array(2).fill({ permissions: { contents: "read", metadata: "read" } }));
  });

  it("answers unreachable when every installation is suspended or the key is malformed", async () => {
    const suspended = githubFor({ files: {}, installs: [{ id: 2, account: { login: "acme" }, suspended_at: "x" }] });
    expect((await fetchSourceTree(suspended.make, { repository_id: 501, commit: COMMIT, path: "p" })).status).toBe("unreachable");
    const g = githubFor({ files: { "p/a": { content: "x" } } });
    const bad = (signal: AbortSignal) => createGithubReader({ fetch: (() => { throw new Error("unreachable"); }) as unknown as typeof fetch, appId: "42", privateKey: "not a key", nowMs: () => 0, signal });
    expect((await fetchSourceTree(bad, { repository_id: 501, commit: COMMIT, path: "p" })).status).toBe("unreachable");
    expect(g.calls).toEqual([]);
  });

  it("stops fetching blobs after the first failure", async () => {
    const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p/${i}`, { content: "x" }]));
    const g = githubFor({ files, blobFail: true });
    expect((await fetchSourceTree(g.make, { repository_id: 501, commit: COMMIT, path: "p" })).status).toBe("unreachable");
    expect(g.calls.filter((c) => c.includes("/git/blobs/")).length).toBeLessThanOrEqual(TREE_LIMITS.concurrency);
  });

  it("says unreachable, not not_found, when GitHub fails or is rate limited", async () => {
    expect(await fetchSourceTree(githubFor({ files: {}, fail: 503 }).make, { repository_id: 501, commit: COMMIT, path: "p" })).toEqual({ status: "unreachable", retry_after_s: TREE_LIMITS.retryAfterS });
    const timedOut = githubFor({ files: { "p/a": { content: "x" } } });
    const result = await fetchSourceTree(timedOut.make, { repository_id: 501, commit: COMMIT, path: "p" }, { ...TREE_LIMITS, deadlineMs: 0 });
    expect(result.status).toBe("unreachable");
  });
});
