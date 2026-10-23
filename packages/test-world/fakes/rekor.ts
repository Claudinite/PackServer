import { createHash, createVerify } from "node:crypto";
import type { NetHandler } from "./net";

export const REKOR_FAKE_URL = "https://rekor.fake.test";

export interface LoggedEntry {
  logIndex: number;
  /** The artifact digest the entry commits to. */
  digest: string;
  /** The entry as Rekor returns it, base64 in `body`. */
  body: string;
  signature: string;
  publicKeyPem: string;
}

/**
 * The Sigstore log's `POST /api/v1/log/entries` for `hashedrekord`, in the shape the public log answers with.
 * `record` is what a test reads to see what the log holds; `signs` checks a logged signature against the statement.
 */
export class FakeRekor {
  readonly record: LoggedEntry[] = [];
  /** Answer every submission with this status, as an outage or a rejection would. */
  failWith: number | undefined;

  handler(): NetHandler {
    return async (request) => {
      const url = new URL(request.url);
      if (url.origin !== REKOR_FAKE_URL || url.pathname !== "/api/v1/log/entries") return undefined;
      return this.submit(request);
    };
  }

  async submit(request: Request): Promise<Response> {
    if (this.failWith) return new Response("unavailable", { status: this.failWith });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const entry = (await request.json()) as {
      kind?: string;
      spec?: { data?: { hash?: { algorithm?: string; value?: string } }; signature?: { content?: string; publicKey?: { content?: string } } };
    };
    const digest = entry.spec?.data?.hash?.value;
    const signature = entry.spec?.signature?.content;
    const key = entry.spec?.signature?.publicKey?.content;
    if (entry.kind !== "hashedrekord" || entry.spec?.data?.hash?.algorithm !== "sha256" || !digest || !signature || !key) {
      return Response.json({ code: 400, message: "malformed hashedrekord" }, { status: 400 });
    }
    const body = Buffer.from(JSON.stringify({ apiVersion: "0.0.1", kind: "hashedrekord", spec: entry.spec })).toString("base64");
    const logIndex = this.record.length;
    this.record.push({ logIndex, digest, body, signature, publicKeyPem: Buffer.from(key, "base64").toString("utf8") });
    const uuid = createHash("sha256").update(body).digest("hex");
    return Response.json({ [uuid]: { body, integratedTime: 0, logID: "fake-log", logIndex } }, { status: 201 });
  }

  /** Whether the logged signature is valid, under the logged key, over exactly this statement. */
  static signs(entry: LoggedEntry, statement: string): boolean {
    return (
      createHash("sha256").update(statement).digest("hex") === entry.digest &&
      createVerify("sha256").update(statement).verify(entry.publicKeyPem, Buffer.from(entry.signature, "base64"))
    );
  }

  fetch: typeof fetch = (input, init) => this.submit(new Request(input, init));
}
