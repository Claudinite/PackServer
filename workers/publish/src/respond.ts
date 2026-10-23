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
