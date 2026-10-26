import { buildTree, canonicalise } from "@packserver/core/canonical";

export const enc = (text: string) => new TextEncoder().encode(text);

export const samplePack = () =>
  canonicalise(buildTree([{ path: "RULES.md", executable: false, content: enc("# rules\n") }]));

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/** A one-file ustar archive, gzipped, as npm ships its packages. */
export function tgzOf(path: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(enc(path));
  header.set(enc(`${content.length.toString(8).padStart(11, "0")}\0`), 124);
  header[156] = "0".charCodeAt(0);
  const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
  padded.set(content);
  return gzipSync(Buffer.concat([header, padded, new Uint8Array(1024)]));
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
