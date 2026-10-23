export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: "bad-request", message }), {
    status: 400,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function unavailable(message: string, retryAfterS: number): Response {
  return new Response(JSON.stringify({ error: "unavailable", message }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(retryAfterS) },
  });
}

export function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export type BodyRead = { ok: true; value: unknown } | { ok: false; because: "too-large" | "malformed" };

/** Reads a JSON body, counting bytes as they arrive, so a chunked body with no Content-Length is bounded too. */
export async function readJson(request: Request, maxBytes: number): Promise<BodyRead> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return { ok: false, because: "too-large" };
  if (!request.body) return { ok: false, because: "malformed" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, because: "too-large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, because: "malformed" };
  }
}
