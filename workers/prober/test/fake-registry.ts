import {
  buildKeysDocument, buildRoot, buildScopeIndex, createSigner, encodePublicKey, sha256Hex, signKeysDocument, signRoot, signScopeIndex, type RegistryKey, type VersionRecord,
} from "@packserver/core/index";
import { SELFTEST_SIGNATURE_HEADER } from "@packserver/core/selftest";
import type { ProberConfig } from "../src/config";
import { CANARY_PACK, CANARY_VERSION, readConfig } from "../src/config";
import { SELFTEST_PATHS, type SelfTestWorker } from "../src/probes/selftest";

export const NOW = Date.parse("2026-10-26T12:00:00.000Z");
export const REGISTRY = "https://registry.test";
export const PACKS = "https://packs.test";
export const GATED = "https://registry-canary.test";
export const ARCHIVE = new Uint8Array([1, 2, 3, 4]);
export const PRODUCTION_RELEASE = "rel-prod";
export const CANDIDATE_RELEASE = "rel-next";
const SEED = new Uint8Array(32).fill(7);
const SCOPE = "packserver-canary";

export const WORKERS = Object.keys(SELFTEST_PATHS) as SelfTestWorker[];
export const productionVersion = (w: string): string => `v-${w}-prod`;
export const candidateVersion = (w: string): string => `v-${w}-next`;

const version = (sha256: string): VersionRecord => ({
  version: CANARY_VERSION,
  sha256,
  size: ARCHIVE.length,
  published_at: "2026-10-01T00:00:00.000Z",
  status: "active",
  min_engine_version: "1.61001.1",
  requires: [],
  source_commit: null,
  preinstall: { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] },
  verified: false,
  verified_domain: null,
  verified_github_org: null,
  source_verified: false,
  status_changed_at: null,
});

export interface Flaws {
  /** Serve a root signed by a key the prober does not trust. */
  untrustedRoot?: boolean;
  /** Serve documents generated this many ms ago. */
  rootAgeMs?: number;
  rootSerial?: number;
  /** List the canary with this hash instead of the pinned one. */
  listedHash?: string;
  /** The scope entry in the root names a serial the scope file does not carry. */
  scopeSerialSkew?: boolean;
  searchDegraded?: boolean;
  archiveBytes?: Uint8Array;
  githubAnswers?: number;
  selftestFails?: SelfTestWorker;
  /** The gated host ignores the version override, as Cloudflare does on any mistake. */
  ignoreOverride?: boolean;
}

export class FakeRegistry {
  readonly requests: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  flaws: Flaws = {};
  private states = new Set<string>();
  private flows = 0;
  private docs = new Map<string, Uint8Array>();

  private constructor(readonly config: ProberConfig, readonly keys: RegistryKey[]) {}

  static async create(flaws: Flaws = {}, trusted = true): Promise<FakeRegistry> {
    const keys: RegistryKey[] = [{ kid: "2026-10", public_key: await encodePublicKey(SEED), status: "active" }];
    const sha256 = await sha256Hex(ARCHIVE);
    const config = readConfig(
      { REGISTRY_ORIGIN: REGISTRY, PACKS_ORIGIN: PACKS, GATED_ORIGIN: GATED, CANARY_PACK_SHA256: sha256, ...(trusted ? { INDEX_TRUSTED_KEYS: JSON.stringify(keys) } : {}) },
      { accessToken: async () => ({ clientId: "id", clientSecret: "secret" }), selfTestKey: async () => "hmac-key" },
    );
    const fake = new FakeRegistry(config, keys);
    fake.flaws = flaws;
    return fake;
  }

  async publish(): Promise<void> {
    const f = this.flaws;
    const signer = await createSigner({ kid: "2026-10", seed: SEED });
    const other = await createSigner({ kid: "2026-10", seed: new Uint8Array(32).fill(8) });
    const signWith = f.untrustedRoot ? other : signer;
    const now = new Date(NOW - (f.rootAgeMs ?? 0));
    const scope = await signScopeIndex(
      buildScopeIndex({ scope: SCOPE, serial: 4, now, packs: [{ name: CANARY_PACK, versions: [version(f.listedHash ?? this.config.canary.sha256)] }] }),
      signWith,
    );
    const root = await signRoot(buildRoot({ serial: f.rootSerial ?? 9, now, scopes: [{ scope: SCOPE, sha256: scope.sha256, serial: f.scopeSerialSkew ? 5 : 4 }] }), signWith);
    const keys = await signKeysDocument(buildKeysDocument({ serial: 2, now, keys: this.keys }), signWith);
    const put = (path: string, bytes: Uint8Array): void => void this.docs.set(path, bytes);
    put("/index/v1/root.json", root.bytes);
    put("/index/v1/keys.json", keys.bytes);
    put(`/index/v1/${SCOPE}/${scope.sha256}.json`, scope.bytes);
    put(`/${CANARY_PACK}/${CANARY_VERSION}/pack.tar.zst`, f.archiveBytes ?? ARCHIVE);
    put(`/${CANARY_PACK}/${CANARY_VERSION}/attestation.json`, new TextEncoder().encode("{}"));
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    this.requests.push({ url: url.toString(), headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.origin === PACKS) {
      const doc = this.docs.get(url.pathname);
      return doc ? new Response(doc as Uint8Array<ArrayBuffer>) : new Response("", { status: 404 });
    }
    if (url.origin === GATED && (headers["cf-access-client-id"] !== "id" || headers["cf-access-client-secret"] !== "secret" || !headers[SELFTEST_SIGNATURE_HEADER.toLowerCase()])) {
      return new Response("", { status: 404 });
    }
    const override = url.origin === GATED && !this.flaws.ignoreOverride ? headers["cloudflare-workers-version-overrides"] : undefined;
    const release = override ? CANDIDATE_RELEASE : PRODUCTION_RELEASE;
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "x-packserver-version": release, "content-type": "application/json", ...extra } });

    const worker = WORKERS.find((w) => url.pathname === SELFTEST_PATHS[w]);
    if (worker) {
      const overridden = override?.includes(`${worker}="`) ?? false;
      const bad = this.flaws.selftestFails === worker;
      return reply({ version_id: overridden ? candidateVersion(worker) : productionVersion(worker), release_id: overridden ? CANDIDATE_RELEASE : PRODUCTION_RELEASE, ok: !bad, checks: [{ name: "d1.query", ok: !bad, ms: 3, detail: "ok" }] });
    }
    if (url.pathname === "/mcp") return this.mcp(JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }, reply);
    if (url.pathname === "/api/auth/github") {
      const state = `st4te${++this.flows}`;
      return reply({ redirect: `https://github.com/login/oauth/authorize?client_id=abc&state=${state}&code_challenge=x&code_challenge_method=S256` }, 200, { "set-cookie": `__Host-github-state=${state}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax` });
    }
    if (url.pathname === "/api/auth/github/callback") {
      const state = url.searchParams.get("state") ?? "";
      const spent = this.states.has(state);
      this.states.add(state);
      return reply({}, spent ? 400 : (this.flaws.githubAnswers ?? 502));
    }
    return reply({}, 404);
  };

  private mcp(message: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }, reply: (body: unknown, status?: number) => Response): Response {
    const result = (value: unknown): Response => reply({ jsonrpc: "2.0", id: message.id, result: value });
    const tool = (answer: unknown): Response => result({ isError: false, content: [{ type: "text", text: JSON.stringify(answer) }] });
    switch (message.method) {
      case "initialize": return result({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "registry", version: "1" } });
      case "notifications/initialized": return reply("", 202);
      case "tools/list": return result({ tools: ["search_packs", "get_pack", "get_download", "list_categories"].map((name) => ({ name })) });
      case "tools/call": {
        const name = message.params?.name;
        if (name === "list_categories") return tool({ categories: [] });
        if (name === "search_packs") return tool({ cards: [{ id: CANARY_PACK }], degraded: this.flaws.searchDegraded === true });
        if (name === "get_pack") return tool({ id: CANARY_PACK });
        return tool({ id: CANARY_PACK, version: CANARY_VERSION, status: "active", url: `${PACKS}/${CANARY_PACK}/${CANARY_VERSION}/pack.tar.zst`, sha256: this.config.canary.sha256, attestation_url: `${PACKS}/${CANARY_PACK}/${CANARY_VERSION}/attestation.json` });
      }
      default: return reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } });
    }
  }
}
