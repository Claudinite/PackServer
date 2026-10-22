import type { Context } from "hono";

/** No requirement names a body limit; forms and JSON here are small, so this is the chosen cap. */
export const MAX_BODY_BYTES = 64 * 1024;

export class BodyTooLarge extends Error {}

/** Reads a clone of the body, so the handler still gets the original, and stops at the cap. */
export async function readBoundedBody(c: Context): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const stream = c.req.raw.clone().body;
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      void reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export function isFormRequest(c: Context): boolean {
  const type = c.req.header("content-type") ?? "";
  return type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
}

/** The form's fields, or `{}` for a non-form body; throws BodyTooLarge before anything is parsed. */
export async function formFields(c: Context): Promise<Record<string, unknown>> {
  if (!isFormRequest(c)) return {};
  // An earlier middleware that already parsed the form has bounded it.
  if (!c.req.raw.bodyUsed) await readBoundedBody(c);
  return c.req.parseBody();
}
