import { findSecrets } from "../validation/text/doc.ts";
import { MAX_ATTACHMENT_BYTES } from "./constants.ts";

export type AttachmentRefusal = "empty" | "too_large" | "unsupported" | "type_mismatch" | "secret";

export type AttachmentVerdict =
  | { ok: true; content_type: string; disposition: "inline" | "attachment" }
  | { ok: false; reason: AttachmentRefusal; message: string };

const IMAGES: Record<string, { type: string; magic: (b: Uint8Array) => boolean }> = {
  png: { type: "image/png", magic: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { type: "image/jpeg", magic: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { type: "image/jpeg", magic: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  gif: { type: "image/gif", magic: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  webp: { type: "image/webp", magic: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]) },
};
const TEXT = new Set(["txt", "log", "md", "json", "csv", "yaml", "yml", "diff", "patch"]);
/** Formats a browser runs or renders: kept, but only ever as a download of opaque bytes. */
const ACTIVE = new Set(["svg", "html", "htm", "xhtml", "xml", "js", "mjs"]);

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((v, i) => bytes[i] === v);

const extensionOf = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** The name a download is saved under: no path, no control characters, no quote or header-breaking character. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to strip control characters
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\x00-\x1f\x7f"<>:|?*]/g, "").trim().slice(0, 100);
  return base === "" || base === "." || base === ".." ? "attachment" : base;
}

/**
 * Decides what a report attachment may be and how it is served. The claimed type is only checked against the
 * bytes, never trusted; active formats are accepted as downloads only (REQ-MOD-004). The scan sees every byte, so
 * a secret in an image's metadata is as blocked as one in a log.
 */
export function classifyAttachment(input: { name: string; bytes: Uint8Array }): AttachmentVerdict {
  const { bytes } = input;
  if (bytes.length === 0) return { ok: false, reason: "empty", message: "The file is empty." };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too_large", message: "Attachments can be at most 5 MB." };

  const extension = extensionOf(input.name);
  const image = IMAGES[extension];
  let verdict: AttachmentVerdict;
  if (image) {
    verdict = image.magic(bytes)
      ? { ok: true, content_type: image.type, disposition: "inline" }
      : { ok: false, reason: "type_mismatch", message: `The file is not a ${extension.toUpperCase()} image.` };
  } else if (TEXT.has(extension)) {
    verdict = { ok: true, content_type: "text/plain; charset=utf-8", disposition: "inline" };
  } else if (ACTIVE.has(extension)) {
    verdict = { ok: true, content_type: "application/octet-stream", disposition: "attachment" };
  } else {
    return { ok: false, reason: "unsupported", message: "Attach an image (PNG, JPEG, GIF, WebP) or a text file (log, txt, md, json, csv)." };
  }
  if (!verdict.ok) return verdict;

  const hit = findSecrets(new TextDecoder("latin1").decode(bytes)).find((h) => !h.placeholder);
  if (hit) {
    return { ok: false, reason: "secret", message: `The file contains a secret (${hit.kind}). Remove it and rotate it, then attach the file again.` };
  }
  return verdict;
}

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
export const base64ToBytes = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
