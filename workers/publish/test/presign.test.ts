import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { awsPresigner } from "../src/upload/presign";

const presigner = awsPresigner({
  endpoint: async () => "https://acct.r2.cloudflarestorage.com/packs-staging",
  accessKeyId: async () => "AKIA",
  secretAccessKey: async () => "secret",
});
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const request = { key: "staging/acme/gcp/1.0.0/c1.tar.zst", contentLength: 1000, contentType: "application/zstd", metadata: { "x-amz-meta-staging-lifetime": "draft" }, nowMs: NOW, expiresInSeconds: 900 };

describe("presigner", () => {
  it("signs a single-object PUT whose length, type, write-once precondition and metadata are part of the signature", async () => {
    const { url, headers } = await presigner.presignPut(request);
    const u = new URL(url);
    expect(u.host).toBe("acct.r2.cloudflarestorage.com");
    expect(u.pathname).toBe(`/packs-staging/${request.key}`);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Date")).toBe("20261022T120000Z");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;if-none-match;x-amz-meta-staging-lifetime");
    expect(headers).toMatchObject({ "content-length": "1000", "if-none-match": "*", "content-type": "application/zstd" });
  });

  it("verifies against the same secret and no other, and a changed length does not verify", async () => {
    const { url, headers } = await presigner.presignPut(request);
    const check = async (secret: string, over: Record<string, string> = {}) => {
      const stripped = new URL(url);
      for (const k of [...stripped.searchParams.keys()]) if (k.startsWith("X-Amz-") && k !== "X-Amz-Expires") stripped.searchParams.delete(k);
      const signed = await new AwsClient({ accessKeyId: "AKIA", secretAccessKey: secret, service: "s3", region: "auto" }).sign(stripped.toString(), {
        method: "PUT", headers: { ...headers, ...over }, aws: { signQuery: true, allHeaders: true, datetime: "20261022T120000Z" },
      });
      return new URL(signed.url).searchParams.get("X-Amz-Signature") === new URL(url).searchParams.get("X-Amz-Signature");
    };
    expect(await check("secret")).toBe(true);
    expect(await check("other")).toBe(false);
    expect(await check("secret", { "content-length": "1001" })).toBe(false);
  });

  it("is a pure function of the clock it is given", async () => {
    expect(await presigner.presignPut(request)).toEqual(await presigner.presignPut(request));
    expect((await presigner.presignPut({ ...request, nowMs: NOW + 1000 })).url).not.toBe((await presigner.presignPut(request)).url);
  });
});
