import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { GithubRuntime } from "../src/bindings";
import { expectScanRan } from "../src/scan/scheduled";
import { githubScanSource } from "../src/scan/github-source";

interface Call {
  method: string;
  url: string;
  authorization: string | null;
}

function stubFetch(answer: (url: URL) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url, authorization: new Headers(init.headers).get("authorization") });
    return answer(new URL(url));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("the scan's GitHub source", () => {
  it("searches and reads with GET and the one token it is given", async () => {
    const { fetchFn, calls } = stubFetch((url) =>
      url.pathname === "/search/code"
        ? Response.json({ total_count: 1, items: [{ path: "conf/settings.yaml", repository: { full_name: "a/b", private: false } }] }, { headers: { "x-ratelimit-remaining": "7", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) } })
        : new Response("packs:\n"),
    );
    const source = githubScanSource({ fetch: fetchFn, token: "tok" });
    const page = await source.search('"@a/b" size:0..99', 2);
    expect(page).toMatchObject({ totalCount: 1, hits: [{ repository: "a/b", private: false, path: "conf/settings.yaml" }], rateRemaining: 7 });
    expect("limited" in page ? 0 : page.rateResetInS).toBeGreaterThan(0);
    expect(await source.readFile("a/b", "conf/settings.yaml")).toBe("packs:\n");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls.every((c) => c.authorization === "Bearer tok")).toBe(true);
    expect(calls[0]!.url).toContain("page=2");
    expect(decodeURIComponent(calls[0]!.url)).toContain('q="@a/b" size:0..99');
  });

  it("reports a spent allowance as such, treats a missing or hidden file as absent, and a failure as unreachable", async () => {
    const limited = githubScanSource({ fetch: stubFetch(() => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "42" } })).fetchFn, token: "t" });
    expect(await limited.search("q", 1)).toEqual({ limited: { retryAfterS: 42 } });
    const hidden = githubScanSource({ fetch: stubFetch(() => new Response("", { status: 404 })).fetchFn, token: "t" });
    expect(await hidden.readFile("a/private", "x")).toBeNull();
    const down = githubScanSource({ fetch: stubFetch(() => new Response("", { status: 502 })).fetchFn, token: "t" });
    await expect(down.search("q", 1)).rejects.toThrow(/502/);
    await expect(down.readFile("a/b", "x")).rejects.toThrow(/502/);
  });
});

describe("the request timeout", () => {
  it("abandons a request that never answers instead of carrying the run past its stop", async () => {
    const hung = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const source = githubScanSource({ fetch: hung, token: "t", timeoutMs: 20 });
    await expect(source.search("q", 1)).rejects.toThrow(/aborted/);
    await expect(source.readFile("a/b", "x")).rejects.toThrow(/aborted/);
  }, 2000);
});

describe("what a cron fire does with the scan's answer", () => {
  const answer = (outcome: string, status = 200) => Response.json({ outcome }, { status });
  it("fails only when GitHub could not be reached", async () => {
    await expect(expectScanRan(answer("unreachable"))).rejects.toThrow(/unreachable/);
    await expect(expectScanRan(answer("unconfigured", 503))).rejects.toThrow();
    for (const outcome of ["completed", "idle", "deadline", "request_budget", "rate_limited"]) await expect(expectScanRan(answer(outcome))).resolves.toBeUndefined();
  });
});

describe("the scan route", () => {
  const runtime = (token: string | null, fetchFn: typeof fetch, packs: string[] = []) => {
    const ports = createFakePorts({ worker: "github" });
    ports.d1
      .on(/from adoption_scans where completed_at is null/, () => ({ rows: [] }))
      .on(/max\(completed_at\)/, () => ({ rows: [{ at: null }] }))
      .on(/insert into adoption_scans/, () => ({}))
      .on(/from packs p join scopes/, (params) => ({ rows: packs.filter((n) => n > String(params[0])).slice(0, 1).map((name) => ({ name })) }))
      .on(/update adoption_scans set completed_at/, () => ({}))
      .on(/delete from/, () => ({}))
      .on(/count\(distinct repository\)/, () => ({ rows: [{ repositories: 0, packs: 0 }] }))
      .on(/update adoption_scans set cursor/, () => ({}));
    const rt = {
      worker: "github",
      environment: "test",
      version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
      missingBindings: [],
      missingSecrets: [],
      ports,
      services: {
        secrets: { webhook: async () => "", appId: async () => "", privateKey: async () => "", codeSearchToken: async () => (token ?? Promise.reject(new Error("no secret"))) },
        fetch: fetchFn,
      },
    } as unknown as GithubRuntime;
    return { rt, ports };
  };

  it("completes a scan with nothing to search and records that it did", async () => {
    const { rt, ports } = runtime("tok", stubFetch(() => new Response("", { status: 404 })).fetchFn);
    const res = await createApp(rt).fetch(new Request("https://github.internal/internal/scan", { method: "POST" }));
    expect(await res.json()).toMatchObject({ outcome: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.stats.points.map((p) => p.name)).toContain("github.scan_completed");
  });

  const runOutcome = async (fetchFn: typeof fetch, packs: string[]) => {
    const { rt, ports } = runtime("tok", fetchFn, packs);
    const res = await createApp(rt).fetch(new Request("https://github.internal/internal/scan", { method: "POST" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attrs = (name: string) => ports.stats.points.filter((p) => p.name === name).map((p) => JSON.parse(p.blobs[3]!) as Record<string, unknown>);
    return { body: (await res.json()) as { outcome: string }, run: attrs("github.scan_run"), completed: attrs("github.scan_completed") };
  };

  it("records every run with its outcome and a completion only for a completed scan", async () => {
    const done = await runOutcome(stubFetch(() => Response.json({ total_count: 0, items: [] })).fetchFn, ["@a/b"]);
    expect(done.run).toEqual([expect.objectContaining({ outcome: "completed" })]);
    expect(done.completed).toHaveLength(1);

    const down = await runOutcome(stubFetch(() => new Response("", { status: 502 })).fetchFn, ["@a/b"]);
    expect(down.body.outcome).toBe("unreachable");
    expect(down.run).toEqual([expect.objectContaining({ outcome: "unreachable" })]);
    expect(down.completed).toEqual([]);
  });

  it("answers 503 and searches nothing when the code-search token cannot be read", async () => {
    const { fetchFn, calls } = stubFetch(() => new Response("", { status: 404 }));
    const { rt } = runtime(null, fetchFn);
    const res = await createApp(rt).fetch(new Request("https://github.internal/internal/scan", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });
});
