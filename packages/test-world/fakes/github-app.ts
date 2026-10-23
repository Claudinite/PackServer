import { createHash, createHmac, randomUUID, createPublicKey, verify } from "node:crypto";
import type { NetHandler } from "./net";

/** Matches `GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_ID` in the GitHub Worker's `env.test`; a test holds the two together. */
export const GITHUB_TEST_WEBHOOK_SECRET = "whsec_test_00000000000000000000000000000000";
export const GITHUB_TEST_APP_ID = "424242";

/** The public half of the key in the Worker's `env.test`; the fake verifies the App JWT with it. */
const APP_PUBLIC_JWK = {
  kty: "RSA",
  e: "AQAB",
  n: "msiiT-2ART28nHiZLQLl65S1Rd4ydxn5H7Svq264g8HgVTgSBtZEwb24Rju6WV-13Z-CA8kiK9TdVQR_o-J94DZlVn-lUmUv4KUtG7yF8KPIVYDlao1Mwj5LX_M7-9mCbHKkGNOT-pUnYtbIPD72VILwKWHXzkiaYSoxdkfG8SNJflhcNYLyBcCqtCO7pxf0ge0B6ycZa2PpZUf3y4gGWfnE2ZYOwkjeHP1jsrcky6aAIFo0jJ8g2S0scqOZDIETaBiL-k14HZ9Wki4W8O8-kFtZ7M66ZgHBezMwYVOtAlQ8L_nWl1ap_F87LOgm0Tu_Sd7V4804li3RIjeehgcB6Q",
};

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

export interface FakeFile {
  content: string | Uint8Array;
  executable?: boolean;
  /** A raw git mode, for the entries a source tree must refuse (`120000` symlink, `160000` submodule). */
  mode?: string;
}

export interface FakeRepo {
  id: number;
  slug: string;
  private: boolean;
  commits: Map<string, Map<string, FakeFile>>;
}

export interface RecordedRequest {
  method: string;
  path: string;
}

export interface Delivery {
  headers: Record<string, string>;
  body: string;
}

/**
 * GitHub's REST API as the App sees it, and the source of its signed webhooks. It serves reads
 * only: every other request is recorded in `writes` and refused, so a product that wrote to
 * GitHub shows up there. Minting an installation token is the one POST that is not a write.
 */
export class FakeGithubApp {
  readonly repos = new Map<number, FakeRepo>();
  readonly requests: RecordedRequest[] = [];
  readonly writes: RecordedRequest[] = [];
  installations: Array<{ id: number; account: { login: string }; suspended_at: string | null }> = [{ id: 5, account: { login: "acme" }, suspended_at: null }];
  tokensMinted = 0;
  /** A status to answer every API call with, to make GitHub fail. */
  failWith: number | undefined;
  private tokens = new Set<string>();

  reset(): void {
    this.repos.clear();
    this.requests.length = 0;
    this.writes.length = 0;
    this.installations = [{ id: 5, account: { login: "acme" }, suspended_at: null }];
    this.tokensMinted = 0;
    this.failWith = undefined;
    this.tokens.clear();
  }

  repo(slug: string, options: { id?: number; private?: boolean } = {}): FakeRepo {
    const existing = [...this.repos.values()].find((r) => r.slug === slug);
    if (existing) return existing;
    const repo: FakeRepo = { id: options.id ?? 500 + this.repos.size + 1, slug, private: options.private ?? false, commits: new Map() };
    this.repos.set(repo.id, repo);
    return repo;
  }

  /** Records a commit holding exactly these files and returns its sha. */
  commit(repo: FakeRepo, files: Record<string, string | FakeFile>): string {
    const tree = new Map(Object.entries(files).map(([path, f]) => [path, typeof f === "string" ? { content: f } : f]));
    const sha = sha1(`${repo.slug}:${repo.commits.size}:${[...tree.keys()].join("\n")}`);
    repo.commits.set(sha, tree);
    return sha;
  }

  /** A webhook as GitHub would send it, signed with the App's secret unless told otherwise. */
  delivery(event: string, payload: unknown, options: { signature?: "wrong" | "missing"; deliveryId?: string } = {}): Delivery {
    // Real deliveries differ by timestamps and ids; the nonce keeps two sent alike from being one replay.
    const body = JSON.stringify({ ...(payload as object), delivery_nonce: randomUUID() });
    const mac = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": options.deliveryId ?? randomUUID(),
    };
    if (options.signature !== "missing") headers["x-hub-signature-256"] = mac(options.signature === "wrong" ? "not-the-secret" : GITHUB_TEST_WEBHOOK_SECRET);
    return { headers, body };
  }

  handler(): NetHandler {
    return (request) => {
      const url = new URL(request.url);
      if (url.host !== "api.github.com") return undefined;
      const path = `${url.pathname}${url.search}`;
      this.requests.push({ method: request.method, path });
      const mint = request.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname);
      if (request.method !== "GET" && !mint) {
        this.writes.push({ method: request.method, path });
        return Response.json({ message: "read-only" }, { status: 403 });
      }
      if (this.failWith) return Response.json({ message: "unavailable" }, { status: this.failWith, headers: { "retry-after": "7" } });
      return this.serve(request, url, mint);
    };
  }

  private async serve(request: Request, url: URL, mint: boolean): Promise<Response> {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.pathname.startsWith("/app/")) {
      if (!this.validAppJwt(bearer)) return json({ message: "Bad credentials" }, 401);
      if (mint) {
        const asked = ((await request.json().catch(() => ({}))) as { permissions?: Record<string, string> }).permissions;
        if (!asked || Object.values(asked).some((level) => level !== "read")) this.writes.push({ method: "POST", path: `${url.pathname} (not read-only)` });
        if (this.installations.find((i) => url.pathname.includes(`/${i.id}/`))?.suspended_at) return json({ message: "suspended" }, 403);
        const token = `ghs_fake_${++this.tokensMinted}`;
        this.tokens.add(token);
        return json({ token, expires_at: "2099-01-01T00:00:00Z" }, 201);
      }
      return json(this.installations);
    }
    if (!this.tokens.has(bearer)) return json({ message: "Bad credentials" }, 401);

    const byId = /^\/repositories\/(\d+)$/.exec(url.pathname);
    if (byId) {
      const repo = this.repos.get(Number(byId[1]));
      return repo ? json(this.describe(repo)) : json({ message: "Not Found" }, 404);
    }
    const tree = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([0-9a-f]+)$/.exec(url.pathname);
    if (tree) {
      const files = this.bySlug(tree[1]!)?.commits.get(tree[2]!);
      if (!files) return json({ message: "Not Found" }, 404);
      const entries = [...files].map(([path, f]) => ({
        path,
        mode: f.mode ?? (f.executable ? "100755" : "100644"),
        type: (f.mode ?? "") === "160000" ? "commit" : "blob",
        sha: this.blobSha(f),
        size: this.bytes(f).length,
      }));
      return json({ sha: tree[2], tree: entries, truncated: false });
    }
    const blob = /^\/repos\/([^/]+\/[^/]+)\/git\/blobs\/([0-9a-f]+)$/.exec(url.pathname);
    if (blob) {
      const file = [...(this.bySlug(blob[1]!)?.commits.values() ?? [])].flatMap((m) => [...m.values()]).find((f) => this.blobSha(f) === blob[2]);
      return file ? new Response(Buffer.from(this.bytes(file))) : json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  }

  private describe(repo: FakeRepo) {
    return { id: repo.id, full_name: repo.slug, default_branch: "main", private: repo.private, archived: false };
  }
  private bySlug(slug: string): FakeRepo | undefined {
    return [...this.repos.values()].find((r) => r.slug === slug);
  }
  private bytes(file: FakeFile): Uint8Array {
    return typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
  }
  private blobSha(file: FakeFile): string {
    return sha1(Buffer.from(this.bytes(file)).toString("base64"));
  }

  private validAppJwt(token: string): boolean {
    const [head, payload, signature] = token.split(".");
    if (!head || !payload || !signature) return false;
    const key = createPublicKey({ key: APP_PUBLIC_JWK, format: "jwk" });
    if (!verify("sha256", Buffer.from(`${head}.${payload}`), key, Buffer.from(signature, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string; iat?: number; exp?: number };
    return claims.iss === GITHUB_TEST_APP_ID && typeof claims.iat === "number" && typeof claims.exp === "number" && claims.exp - claims.iat <= 600;
  }
}
