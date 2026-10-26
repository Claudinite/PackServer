import { sha256Hex } from "../src/hash";
import {
  PortError,
  type AccessIdentity,
  type AccessIdentityClaims,
  type AuthFileAnswer,
  type Dns,
  type WellKnown,
  type Embedder,
  type GitHub,
  type GitHubRepo,
  type GitHubTreeEntry,
  type Mail,
  type MailMessage,
  type OidcClaims,
  type OidcVerifier,
  type ProseScreen,
  type ProseScreenRequest,
  type ProseScreenResult,
  type Sandbox,
  type SandboxInspectRequest,
  type SandboxInspectResult,
  type SandboxRunRequest,
  type SandboxRunResult,
  type Turnstile,
  type VectorIndex,
  type VectorMatch,
} from "../src/ports";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** Read-only by construction: there is no write method to call or to record. */
export class FakeGitHub implements GitHub {
  readonly repos = new Map<string, GitHubRepo>();
  readonly files = new Map<string, Uint8Array>();
  readonly refs = new Map<string, string>();
  readonly trees = new Map<string, GitHubTreeEntry[]>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly code: Array<{ repo: string; path: string; text: string }> = [];
  async getRepo(slug: string) {
    return this.repos.get(slug) ?? null;
  }
  async getRef(slug: string, ref: string) {
    const sha = this.refs.get(`${slug}@${ref}`);
    return sha ? { sha } : null;
  }
  async getTree(slug: string, sha: string) {
    return this.trees.get(`${slug}@${sha}`) ?? [];
  }
  async getBlob(_slug: string, sha: string) {
    return this.blobs.get(sha) ?? null;
  }
  async getFile(slug: string, ref: string, path: string) {
    return this.files.get(`${slug}@${ref}:${path}`) ?? null;
  }
  async searchCode(query: string) {
    return this.code.filter((c) => c.text.includes(query)).map(({ repo, path }) => ({ repo, path }));
  }
}

/** Tokens are minted by the fake and verified by exact lookup, so a forged or altered token is a real negative. */
export class FakeOidcVerifier implements OidcVerifier {
  private readonly minted = new Map<string, OidcClaims>();
  private counter = 0;
  constructor(private readonly nowMs: () => number) {}
  mint(claims: Partial<OidcClaims> & Pick<OidcClaims, "aud">): string {
    const now = Math.floor(this.nowMs() / 1000);
    const full: OidcClaims = {
      iss: GITHUB_OIDC_ISSUER,
      sub: "repo:acme/pack:ref:refs/heads/main",
      repository: "acme/pack",
      repository_owner: "acme",
      repository_id: "1",
      ref: "refs/heads/main",
      ref_protected: "true",
      job_workflow_ref: "acme/pack/.github/workflows/publish.yml@refs/heads/main",
      event_name: "push",
      run_id: "1",
      jti: `jti-${++this.counter}`,
      iat: now,
      exp: now + 300,
      ...claims,
    };
    const token = `fake.${full.jti}.${this.counter}`;
    this.minted.set(token, full);
    return token;
  }
  async verify(token: string, options: { audience: string }) {
    const claims = this.minted.get(token);
    if (!claims) throw new PortError("bad_signature", "token was not issued by this issuer");
    if (claims.iss !== GITHUB_OIDC_ISSUER) throw new PortError("bad_issuer", `issuer ${claims.iss} is not GitHub's`);
    if (claims.aud !== options.audience) throw new PortError("bad_audience", "audience mismatch");
    if (claims.exp * 1000 <= this.nowMs()) throw new PortError("expired", "token expired");
    return claims;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Brute-force cosine. */
export class FakeVectorIndex implements VectorIndex {
  readonly items = new Map<string, { vector: number[]; metadata: VectorMatch["metadata"] }>();
  async upsert(items: Array<{ id: string; vector: number[]; metadata?: VectorMatch["metadata"] }>) {
    for (const i of items) this.items.set(i.id, { vector: i.vector, metadata: i.metadata ?? {} });
  }
  async query(vector: number[], options: { topK: number }) {
    return [...this.items.entries()]
      .map(([id, v]) => ({ id, score: cosine(vector, v.vector), metadata: v.metadata }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, options.topK);
  }
  async deleteByIds(ids: string[]) {
    ids.forEach((id) => this.items.delete(id));
  }
}

/** Deterministic: hashes each text into a unit vector; a recorded table overrides it for meaning queries. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-embedder";
  readonly dimensions = 16;
  readonly table = new Map<string, number[]>();
  async embed(texts: string[]) {
    return Promise.all(
      texts.map(async (t) => {
        const known = this.table.get(t);
        if (known) return known;
        const hex = await sha256Hex(t);
        const raw = Array.from({ length: this.dimensions }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) - 127.5);
        const norm = Math.sqrt(raw.reduce((n, x) => n + x * x, 0));
        return raw.map((x) => x / norm);
      }),
    );
  }
}

export class FakeSandbox implements Sandbox {
  readonly inspected: SandboxInspectRequest[] = [];
  readonly ran: SandboxRunRequest[] = [];
  private a: ((request: SandboxInspectRequest) => SandboxInspectResult) | undefined;
  private b: ((request: SandboxRunRequest) => SandboxRunResult) | undefined;
  scriptInspect(answer: (request: SandboxInspectRequest) => SandboxInspectResult) {
    this.a = answer;
  }
  scriptRun(answer: (request: SandboxRunRequest) => SandboxRunResult) {
    this.b = answer;
  }
  async inspect(request: SandboxInspectRequest) {
    this.inspected.push(request);
    if (!this.a) throw new PortError("unscripted", "no sandbox A script");
    return this.a(request);
  }
  async run(request: SandboxRunRequest) {
    this.ran.push(request);
    if (!this.b) throw new PortError("unscripted", "no sandbox B script");
    return this.b(request);
  }
}

/** Keeps every request it saw so a test can assert what was (and was not) sent. */
export class FakeProseScreen implements ProseScreen {
  readonly requests: ProseScreenRequest[] = [];
  constructor(private readonly probabilities: Record<string, number> = {}) {}
  async screen(request: ProseScreenRequest): Promise<ProseScreenResult> {
    this.requests.push(request);
    return {
      implementation: "static-only",
      model_version: null,
      chunks: request.chunks.map((c) => ({ id: c.id, probabilities: this.probabilities })),
    };
  }
}

export class FakeMail implements Mail {
  readonly sent: Array<MailMessage & { id: string }> = [];
  async send(message: MailMessage) {
    const id = `mail-${this.sent.length + 1}`;
    this.sent.push({ ...message, id });
    return { id };
  }
  inbox(address: string) {
    return this.sent.filter((m) => m.to === address);
  }
}

export class FakeDns implements Dns {
  readonly txt = new Map<string, string[]>();
  async resolveTxt(name: string) {
    return this.txt.get(name) ?? [];
  }
}

export class FakeWellKnown implements WellKnown {
  readonly files = new Map<string, AuthFileAnswer>();
  readonly fetched: string[] = [];
  async authFile(host: string): Promise<AuthFileAnswer> {
    this.fetched.push(host);
    return this.files.get(host) ?? { status: "absent", reason: "not_found" };
  }
}

export const TURNSTILE_PASS_TOKEN = "turnstile-test-pass";

export class FakeTurnstile implements Turnstile {
  async verify(token: string) {
    return token === TURNSTILE_PASS_TOKEN ? { success: true, codes: [] } : { success: false, codes: ["invalid-input-response"] };
  }
}

/** Assertions are `<email>|<sub>|<signature>`, verified against a test key by recomputation. */
export class FakeAccessIdentity implements AccessIdentity {
  constructor(private readonly testKey = "access-test-key") {}
  async assert(claims: AccessIdentityClaims): Promise<string> {
    return `${claims.email}|${claims.sub}|${await sha256Hex(`${this.testKey}|${claims.email}|${claims.sub}`)}`;
  }
  async verify(assertion: string) {
    const [email, sub, sig] = assertion.split("|");
    if (!email || !sub || sig !== (await sha256Hex(`${this.testKey}|${email}|${sub}`))) {
      throw new PortError("bad_assertion", "assertion signature does not verify");
    }
    return { email, sub };
  }
}
