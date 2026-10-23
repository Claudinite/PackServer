/**
 * The control plane every fake Worker shares: the test process steers a fake over `fetch`
 * (`POST /__control/<op>` with a JSON body) and the system under test calls it over RPC.
 * Fake Workers exist only in the test harness, so nothing here ships.
 */
export type ControlHandlers = Record<string, (args: never) => unknown>;

export async function handleControl(request: Request, handlers: ControlHandlers): Promise<Response> {
  const op = new URL(request.url).pathname.replace(/^\/__control\//, "");
  const handler = handlers[op];
  if (request.method !== "POST" || !new URL(request.url).pathname.startsWith("/__control/") || !handler) {
    return new Response("Not Found", { status: 404 });
  }
  const args = request.headers.get("content-length") === "0" ? undefined : await request.json().catch(() => undefined);
  return Response.json({ result: (await handler(args as never)) ?? null });
}
