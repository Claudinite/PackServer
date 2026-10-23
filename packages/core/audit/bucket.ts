import { AwsClient } from "aws4fetch";

/** The audit bucket as the consumer sees it: objects only, reached over the S3 API and never through a binding. */
export interface AuditBucket {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
  /** Up to `limit` keys under the prefix in key order, starting after `startAfter`. */
  list(prefix: string, limit: number, startAfter?: string): Promise<string[]>;
}

export interface S3Config {
  /** `https://<account>.r2.cloudflarestorage.com/<bucket>` */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Keys are `audit/…` with no characters needing escapes beyond path separators. */
export function s3AuditBucket(config: S3Config, fetchImpl: typeof fetch = fetch): AuditBucket {
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto" });
  const base = config.endpoint.replace(/\/+$/, "");
  const send = async (url: string, init: RequestInit) => fetchImpl(await client.sign(url, init));
  return {
    async get(key) {
      const res = await send(`${base}/${key}`, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`audit bucket GET ${key}: ${res.status}`);
      return res.text();
    },
    async put(key, body) {
      const res = await send(`${base}/${key}`, { method: "PUT", body, headers: { "content-type": "application/x-ndjson" } });
      if (!res.ok) throw new Error(`audit bucket PUT ${key}: ${res.status}`);
    },
    async list(prefix, limit, startAfter) {
      const after = startAfter ? `&start-after=${encodeURIComponent(startAfter)}` : "";
      const res = await send(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${limit}${after}`, { method: "GET" });
      if (!res.ok) throw new Error(`audit bucket LIST ${prefix}: ${res.status}`);
      return [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1] as string);
    },
  };
}
