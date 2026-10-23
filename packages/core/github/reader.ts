import type { GitHub, GitHubRepo, GitHubTreeEntry } from "@packserver/ports";
import { appJwt } from "./app-auth.ts";

const API = "https://api.github.com";

/** GitHub could not be asked, or asked and failed: the caller may retry, which is not an answer about the repository. */
export class GithubUnreachable extends Error {
  constructor(
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export interface ReaderOptions {
  fetch: typeof fetch;
  appId: string;
  privateKey: string;
  nowMs: () => number;
  signal?: AbortSignal;
}

export interface GithubRepoById extends GitHubRepo {
  private: boolean;
}

/** The read-only methods of the port the GitHub Worker uses; code search belongs to the weekly scan. */
export type GithubReader = Omit<GitHub, "searchCode"> & {
  getRepoById(id: number): Promise<GithubRepoById | null>;
  getTreeRecursive(slug: string, sha: string): Promise<{ entries: GitHubTreeEntry[]; truncated: boolean } | null>;
};

interface Repo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
}

const toRepo = (r: Repo): GithubRepoById => ({ slug: r.full_name, id: r.id, default_branch: r.default_branch, private: r.private, archived: r.archived });

/**
 * Every request is a GET except the one POST that exchanges the App's identity for an
 * installation token, which changes nothing on GitHub. No method here writes.
 */
export function createGithubReader(options: ReaderOptions): GithubReader {
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await options.fetch(url, { ...init, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      throw new GithubUnreachable(error instanceof Error ? error.message : "request failed");
    }
    if (res.status >= 500 || res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      const retry = Number(res.headers.get("retry-after"));
      await res.body?.cancel();
      throw new GithubUnreachable(`GitHub answered ${res.status}`, Number.isInteger(retry) && retry > 0 ? retry : undefined);
    }
    return res;
  };
  const headers = (token: string, accept = "application/vnd.github+json") => ({
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "packserver-github-worker",
  });

  let token: Promise<string> | undefined;
  const installationToken = (): Promise<string> =>
    (token ??= (async () => {
      const jwt = await appJwt({ appId: options.appId, privateKey: options.privateKey, nowMs: options.nowMs() });
      const list = await send(`${API}/app/installations?per_page=1`, { method: "GET", headers: headers(jwt) });
      const first = list.ok ? ((await list.json()) as Array<{ id: number }>)[0] : undefined;
      if (!first) throw new GithubUnreachable("the App has no installation to read through");
      const minted = await send(`${API}/app/installations/${first.id}/access_tokens`, { method: "POST", headers: headers(jwt) });
      if (!minted.ok) throw new GithubUnreachable(`GitHub refused an installation token (${minted.status})`);
      return ((await minted.json()) as { token: string }).token;
    })());

  const get = async (path: string, accept?: string): Promise<Response | null> => {
    const res = await send(`${API}${path}`, { method: "GET", headers: headers(await installationToken(), accept) });
    if (res.status === 404 || res.status === 409 || res.status === 451) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new GithubUnreachable(`GitHub answered ${res.status}`);
    return res;
  };
  const bytes = async (res: Response | null) => (res ? new Uint8Array(await res.arrayBuffer()) : null);
  const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");

  const treeOf = async (slug: string, sha: string) => {
    const res = await get(`/repos/${slug}/git/trees/${encodeURIComponent(sha)}?recursive=1`);
    if (!res) return null;
    const body = (await res.json()) as { tree: GitHubTreeEntry[]; truncated: boolean };
    return { entries: body.tree, truncated: body.truncated };
  };

  return {
    async getRepo(slug) {
      const res = await get(`/repos/${slug}`);
      return res ? toRepo((await res.json()) as Repo) : null;
    },
    async getRepoById(id) {
      const res = await get(`/repositories/${id}`);
      return res ? toRepo((await res.json()) as Repo) : null;
    },
    async getRef(slug, ref) {
      const res = await get(`/repos/${slug}/commits/${encodeURIComponent(ref)}`);
      return res ? { sha: ((await res.json()) as { sha: string }).sha } : null;
    },
    async getTree(slug, sha) {
      return (await treeOf(slug, sha))?.entries ?? [];
    },
    getTreeRecursive: treeOf,
    async getBlob(slug, sha) {
      return bytes(await get(`/repos/${slug}/git/blobs/${encodeURIComponent(sha)}`, "application/vnd.github.raw+json"));
    },
    async getFile(slug, ref, path) {
      return bytes(await get(`/repos/${slug}/contents/${encode(path)}?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw+json"));
    },
  };
}
