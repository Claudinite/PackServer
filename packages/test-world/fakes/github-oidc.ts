import { base64url, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { OIDC_AUDIENCE } from "@packserver/core/publishing";
import type { NetHandler } from "./net";

type Pair = Awaited<ReturnType<typeof generateKeyPair>>;
interface Key {
  kid: string;
  privateKey: Pair["privateKey"];
  jwk: JWK;
}

export interface MintOptions {
  kid?: string;
  alg?: "RS256" | "HS256" | "none";
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  /** Sign with a key the issuer never published. */
  unpublishedKey?: boolean;
}

/**
 * GitHub's Actions token issuer, faked: an RSA key set served as JWKS from the host the test
 * Worker is configured to trust, and tokens minted with any claims. The first key is made once
 * and restored by `reset`, so a scenario's rotation does not reach the next.
 */
export class FakeGithubOidc {
  readonly issuer: string;
  readonly jwksUrl: string;
  private base: Promise<{ initial: Key; stranger: Key }> | undefined;
  /** Every key made since the scenario began, published or not. */
  private made: Key[] = [];
  private published = new Set<string>();
  private fetches = 0;

  constructor(
    config: { issuer: string; jwksUrl: string },
    private readonly now: () => Promise<number>,
  ) {
    this.issuer = config.issuer;
    this.jwksUrl = config.jwksUrl;
  }

  private async makeKey(label: string): Promise<Key> {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
    const kid = `${label}-${crypto.randomUUID().slice(0, 8)}`;
    return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } };
  }

  private async ready(): Promise<{ initial: Key; stranger: Key }> {
    this.base ??= Promise.all([this.makeKey("key-a"), this.makeKey("stranger")]).then((keys) => {
      const [initial, stranger] = keys as [Key, Key];
      this.made = [initial];
      this.published = new Set([initial.kid]);
      return { initial, stranger };
    });
    return this.base;
  }

  /** The JWKS endpoint. */
  readonly handler: NetHandler = async (request) => {
    if (request.method !== "GET" || request.url !== this.jwksUrl) return undefined;
    await this.ready();
    this.fetches++;
    return Response.json({ keys: this.made.filter((k) => this.published.has(k.kid)).map((k) => k.jwk) });
  };

  /** How many times the Worker asked for the key set since the scenario began. */
  jwksFetches(): number {
    return this.fetches;
  }

  async keyIds(): Promise<string[]> {
    await this.ready();
    return this.made.filter((k) => this.published.has(k.kid)).map((k) => k.kid);
  }

  /** Publishes a new key and returns its id. */
  async addKey(): Promise<string> {
    await this.ready();
    const key = await this.makeKey("key-b");
    this.made.push(key);
    this.published.add(key.kid);
    return key.kid;
  }

  /** Takes a key out of the published set; tokens it signed earlier can still be minted. */
  removeKey(kid: string): void {
    this.published.delete(kid);
  }

  async mint(claims: Record<string, unknown>, options: MintOptions = {}): Promise<string> {
    const { initial, stranger } = await this.ready();
    const nowS = Math.floor((await this.now()) / 1000);
    const payload: Record<string, unknown> = { iat: nowS, nbf: nowS, exp: nowS + 300, ...claims };
    for (const k of ["iat", "exp", "nbf"] as const) if (options[k] !== undefined) payload[k] = options[k];
    const iss = options.iss ?? this.issuer;
    const aud = options.aud ?? OIDC_AUDIENCE;

    const key = options.unpublishedKey ? stranger : options.kid ? this.made.find((k) => k.kid === options.kid) : this.made.find((k) => this.published.has(k.kid)) ?? initial;
    if (options.alg === "none") {
      const enc = (v: unknown) => base64url.encode(JSON.stringify(v));
      return `${enc({ alg: "none", typ: "JWT", kid: key?.kid })}.${enc({ ...payload, iss, aud })}.`;
    }
    if (options.alg === "HS256") {
      return new SignJWT(payload).setProtectedHeader({ alg: "HS256", kid: key?.kid ?? initial.kid }).setIssuer(iss).setAudience(aud).sign(crypto.getRandomValues(new Uint8Array(32)));
    }
    if (!key) throw new Error(`the fake issuer holds no key ${options.kid}`);
    return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: key.kid }).setIssuer(iss).setAudience(aud).sign(key.privateKey);
  }

  /** An unknown `kid`: signed by a key the issuer never published. */
  async mintUnpublished(claims: Record<string, unknown>): Promise<string> {
    return this.mint(claims, { unpublishedKey: true });
  }

  async reset(): Promise<void> {
    this.fetches = 0;
    if (!this.base) return;
    const { initial } = await this.base;
    this.made = [initial];
    this.published = new Set([initial.kid]);
  }
}
