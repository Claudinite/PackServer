import { AwsClient } from "aws4fetch";

export interface PresignRequest {
  key: string;
  contentLength: number;
  contentType: string;
  /** Custom metadata the object is stored with, as `x-amz-meta-*` headers the client must send unchanged. */
  metadata: Readonly<Record<string, string>>;
  nowMs: number;
  expiresInSeconds: number;
}

export interface Presigned {
  url: string;
  /** The headers the PUT must carry; each is part of the signature. */
  headers: Record<string, string>;
}

export interface Presigner {
  presignPut(request: PresignRequest): Promise<Presigned>;
}

export interface PresignerConfig {
  endpoint: () => Promise<string>;
  accessKeyId: () => Promise<string>;
  secretAccessKey: () => Promise<string>;
}

const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, "");

/**
 * A SigV4 query-signed PUT for one object. `Content-Length`, `Content-Type`, the write-once
 * precondition and the metadata headers are signed, so a PUT that carries different ones does not verify.
 */
export function awsPresigner(config: PresignerConfig): Presigner {
  return {
    async presignPut(request) {
      const base = (await config.endpoint()).replace(/\/+$/, "");
      const client = new AwsClient({
        accessKeyId: await config.accessKeyId(),
        secretAccessKey: await config.secretAccessKey(),
        service: "s3",
        region: "auto",
      });
      const headers: Record<string, string> = {
        "content-length": String(request.contentLength),
        "content-type": request.contentType,
        // R2 refuses a second PUT to a key that exists, so the object a URL writes cannot be replaced through it.
        "if-none-match": "*",
        ...request.metadata,
      };
      const url = new URL(`${base}/${request.key}`);
      url.searchParams.set("X-Amz-Expires", String(request.expiresInSeconds));
      const signed = await client.sign(url.toString(), { method: "PUT", headers, aws: { signQuery: true, allHeaders: true, datetime: amzDate(request.nowMs) } });
      return { url: signed.url, headers };
    },
  };
}
