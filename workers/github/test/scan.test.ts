import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { GithubRuntime } from "../src/bindings";
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
    const page = await source.search('"@a/b" created:2020-01-01..2020-12-31', 2);
    expect(page).toMatchObject({ totalCount: 1, hits: [{ repository: "a/b", private: false, path: "conf/settings.yaml" }], rateRemaining: 7 });
    expect("limited" in page ? 0 : page.rateResetInS).toBeGreaterThan(0);
    expect(await source.readFile("a/b", "conf/settings.yaml")).toBe("packs:\n");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls.every((c) => c.authorization === "Bearer tok")).toBe(true);
    expect(calls[0]!.url).toContain("page=2");
    expect(decodeURIComponent(calls[0]!.url)).toContain('q="@a/b" created:2020-01-01..2020-12-31');
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

describe("the scan route", () => {
  const runtime = (token: string | null, fetchFn: typeof fetch) => {
    const ports = createFakePorts({ worker: "github" });
    ports.d1
      .on(/from adoption_scans where completed_at is null/, () => ({ rows: [] }))
      .on(/max\(completed_at\)/, () => ({ rows: [{ at: null }] }))
      .on(/insert into adoption_scans/, () => ({}))
      .on(/from packs p join scopes/, () => ({ rows: [] }))
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

  it("answers 503 and searches nothing when the code-search token cannot be read", async () => {
    const { fetchFn, calls } = stubFetch(() => new Response("", { status: 404 }));
    const { rt } = runtime(null, fetchFn);
    const res = await createApp(rt).fetch(new Request("https://github.internal/internal/scan", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });
});
