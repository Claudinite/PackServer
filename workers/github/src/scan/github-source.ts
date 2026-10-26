import { GithubUnreachable, SCAN_LIMITS, type ScanSource, type SearchAnswer } from "@packserver/core/github";

const API = "https://api.github.com";

interface CodeSearchBody {
  total_count: number;
  items: Array<{ path: string; repository: { full_name: string; private: boolean } }>;
}

/**
 * GitHub through the read-only public-repository token, with GET requests only. A private
 * repository answers 404 to this token, so a file of one is never readable through it.
 */
export function githubScanSource(options: { fetch: typeof fetch; token: string }): ScanSource {
  const send = (path: string, accept: string): Promise<Response> =>
    options
      .fetch(`${API}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.token}`,
          accept,
          "x-github-api-version": "2022-11-28",
          "user-agent": "packserver-github-worker",
        },
      })
      .catch((error: unknown) => {
        throw new GithubUnreachable(error instanceof Error ? error.message : "request failed");
      });
  const header = (res: Response, name: string): number | null => {
    const value = res.headers.get(name);
    return value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const limited = (res: Response): boolean => res.status === 429 || (res.status === 403 && (header(res, "x-ratelimit-remaining") === 0 || res.headers.has("retry-after")));

  return {
    async search(query, page): Promise<SearchAnswer> {
      const res = await send(`/search/code?q=${encodeURIComponent(query)}&per_page=${SCAN_LIMITS.perPage}&page=${page}`, "application/vnd.github+json");
      const remaining = header(res, "x-ratelimit-remaining");
      const reset = header(res, "x-ratelimit-reset");
      const resetInS = reset === null ? null : Math.max(1, Math.ceil(reset - Date.now() / 1000));
      if (limited(res)) {
        await res.body?.cancel();
        return { limited: { retryAfterS: header(res, "retry-after") ?? resetInS ?? 60 } };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new GithubUnreachable(`GitHub answered ${res.status} to a code search`);
      }
      const body = (await res.json()) as CodeSearchBody;
      return {
        totalCount: body.total_count,
        hits: body.items.map((i) => ({ repository: i.repository.full_name, private: i.repository.private, path: i.path })),
        rateRemaining: remaining,
        rateResetInS: resetInS,
      };
    },

    async readFile(repository, path) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const res = await send(`/repos/${repository}/contents/${encoded}`, "application/vnd.github.raw+json");
      if (res.status === 404 || res.status === 403 || res.status === 451) {
        if (limited(res)) throw new GithubUnreachable("GitHub rate-limited a file read");
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new GithubUnreachable(`GitHub answered ${res.status} to a file read`);
      }
      return await res.text();
    },
  };
}
