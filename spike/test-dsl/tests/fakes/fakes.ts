// Fakes for every outside dependency the system talks to, written as plain
// `(Request) => Response` handlers so the same code serves two transports:
//   - MSW `setupServer` in-process (inprocess driver), and
//   - a real Node http server (http driver against `wrangler dev`).
// Each fake records what it saw into the Recorder.
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import type { Recorder } from "../world/recorder";

export type FakeHandler = (request: Request) => Promise<Response | undefined>;

export class FakeOidc {
  private keys!: { privateKey: CryptoKey; publicKey: CryptoKey };
  private jwks!: { keys: JWK[] };
  constructor(readonly issuer: string, readonly audience: string, private readonly recorder: Recorder) {}

  async init(): Promise<void> {
    this.keys = await generateKeyPair("RS256");
    const jwk = await exportJWK(this.keys.publicKey);
    this.jwks = { keys: [{ ...jwk, kid: "spike-key", alg: "RS256", use: "sig" }] };
  }

  /** What GitHub Actions would hand the publisher: a signed id token with the claims we choose. */
  async mintToken(claims: { email: string; sub?: string }): Promise<string> {
    return new SignJWT({ email: claims.email })
      .setProtectedHeader({ alg: "RS256", kid: "spike-key" })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(claims.sub ?? claims.email)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.keys.privateKey);
  }

  handle: FakeHandler = async (request) => {
    const url = new URL(request.url);
    if (!request.url.startsWith(this.issuer)) return undefined;
    if (url.pathname.endsWith("/.well-known/jwks")) {
      this.recorder.add({ kind: "http", target: url.host, op: "signing-keys", result: { keys: this.jwks.keys.length }, seenBy: "fake" });
      return Response.json(this.jwks);
    }
    return new Response("not found", { status: 404 });
  };
}

export class FakeLlm {
  private nextVerdict = "pass";
  constructor(readonly url: string, private readonly recorder: Recorder) {}

  /** Script the verdict the next validation call returns. */
  willAnswer(verdict: string): void {
    this.nextVerdict = verdict;
  }
  reset(): void {
    this.nextVerdict = "pass";
  }

  handle: FakeHandler = async (request) => {
    if (request.url !== this.url) return undefined;
    const body = (await request.json()) as { name: string };
    const result = { verdict: this.nextVerdict };
    this.recorder.add({ kind: "http", target: new URL(this.url).host, op: "validate", request: { name: body.name }, result, seenBy: "fake" });
    return Response.json(result);
  };
}

export type Fakes = { oidc: FakeOidc; llm: FakeLlm; handlers: FakeHandler[] };

export async function createFakes(recorder: Recorder, hosts: { oidcIssuer: string; llmUrl: string }): Promise<Fakes> {
  const oidc = new FakeOidc(hosts.oidcIssuer, "packserver", recorder);
  await oidc.init();
  const llm = new FakeLlm(hosts.llmUrl, recorder);
  return { oidc, llm, handlers: [oidc.handle, llm.handle] };
}
