import { AwsClient } from "aws4fetch";
import type { NetHandler } from "./net";

export interface StagingS3Config {
  /** `https://<host>/<bucket>`, as the Worker is configured with it. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StagingBucket {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string>; onlyIf?: { etagDoesNotMatch: string } }): Promise<unknown>;
  head(key: string): Promise<unknown>;
}

export interface S3Request {
  method: string;
  key: string;
  outcome: "stored" | "signature" | "expired" | "exists";
}

const META_PREFIX = "x-amz-meta-";

const xml = (status: number, code: string, message: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status, headers: { "content-type": "application/xml" } });

/**
 * The staging bucket's S3 endpoint, faked. A request is accepted only when its SigV4 query
 * signature is the one the configured secret makes over exactly the method, path and signed
 * headers it carries, so a changed length, key or verb is refused the way R2 refuses it.
 */
export class FakeStagingS3 {
  private readonly log: S3Request[] = [];
  private readonly host: string;
  private readonly bucketPath: string;

  constructor(
    private readonly config: StagingS3Config,
    private readonly now: () => Promise<number>,
    private readonly bucket: () => Promise<StagingBucket>,
  ) {
    const url = new URL(config.endpoint);
    this.host = url.host;
    this.bucketPath = url.pathname.replace(/\/+$/, "");
  }

  requests(): S3Request[] {
    return [...this.log];
  }

  reset(): void {
    this.log.length = 0;
  }

  readonly handler: NetHandler = async (request) => {
    const url = new URL(request.url);
    if (url.host !== this.host || !url.pathname.startsWith(`${this.bucketPath}/`)) return undefined;
    const key = decodeURIComponent(url.pathname.slice(this.bucketPath.length + 1));
    const note = (outcome: S3Request["outcome"]) => this.log.push({ method: request.method, key, outcome });

    const params = url.searchParams;
    const signedHeaders = (params.get("X-Amz-SignedHeaders") ?? "").split(";").filter((h) => h && h !== "host");
    const date = params.get("X-Amz-Date") ?? "";
    const body = new Uint8Array(await request.arrayBuffer());
    // The length on the wire is what R2 checks against the signature, whatever the client's header says.
    const headers: Record<string, string> = {};
    for (const name of signedHeaders) headers[name] = name === "content-length" ? String(body.byteLength) : (request.headers.get(name) ?? "");

    const unsigned = new URL(url);
    for (const name of [...unsigned.searchParams.keys()]) if (name.startsWith("X-Amz-") && name !== "X-Amz-Expires") unsigned.searchParams.delete(name);
    const client = new AwsClient({ accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey, service: "s3", region: "auto" });
    const expected = await client.sign(unsigned.toString(), { method: request.method, headers, aws: { signQuery: true, allHeaders: true, datetime: date } });
    const credential = params.get("X-Amz-Credential") ?? "";
    if (new URL(expected.url).searchParams.get("X-Amz-Signature") !== params.get("X-Amz-Signature") || !credential.startsWith(`${this.config.accessKeyId}/`)) {
      note("signature");
      return xml(403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.");
    }
    const issuedAt = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    const nowMs = await this.now();
    if (nowMs < issuedAt || nowMs >= issuedAt + Number(params.get("X-Amz-Expires") ?? 0) * 1000) {
      note("expired");
      return xml(403, "AccessDenied", "Request has expired");
    }
    if (request.method !== "PUT") {
      note("signature");
      return xml(405, "MethodNotAllowed", "Only a single-object PUT is signed");
    }

    const bucket = await this.bucket();
    if (headers["if-none-match"] === "*" && (await bucket.head(key))) {
      note("exists");
      return xml(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold");
    }
    const customMetadata = Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith(META_PREFIX)).map(([k, v]) => [k.slice(META_PREFIX.length), v]));
    await bucket.put(key, body, { httpMetadata: { contentType: headers["content-type"] ?? "application/octet-stream" }, customMetadata });
    note("stored");
    return new Response(null, { status: 200, headers: { etag: '"fake"' } });
  };
}
