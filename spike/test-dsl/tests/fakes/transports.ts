// Two ways to put the fakes on the network.
import { http, HttpResponse, passthrough } from "msw";
import { setupServer, type SetupServer } from "msw/node";
import { createServer, type Server } from "node:http";
import type { FakeHandler } from "./fakes";

async function dispatch(handlers: FakeHandler[], request: Request): Promise<Response | undefined> {
  for (const h of handlers) {
    const res = await h(request.clone() as unknown as Request);
    if (res) return res;
  }
  return undefined;
}

/** (a) MSW in-process: intercepts Node's global fetch, which is where the test harness sends every Worker's egress. */
export function mswTransport(handlers: FakeHandler[], passthroughOrigins: string[] = []): SetupServer {
  const server = setupServer(
    http.all("*", async ({ request }) => {
      if (process.env.FAKES_DEBUG) console.error("[fakes] saw", request.method, request.url);
      if (passthroughOrigins.some((o) => request.url.startsWith(o))) return passthrough();
      const res = await dispatch(handlers, request).catch((e) => { console.error("[fakes] handler threw", e); throw e; });
      if (process.env.FAKES_DEBUG) console.error("[fakes] answered", res?.status ?? "unhandled");
      if (res) return res;
      // Returning nothing lets MSW treat it as unhandled -> onUnhandledRequest: "error" fires.
      return undefined;
    }),
  );
  return server;
}

/** (b) A real listening server, for a system running outside the test process (wrangler dev). */
export function listeningTransport(handlers: FakeHandler[], port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });
    const out = (await dispatch(handlers, request)) ?? new Response("unhandled external request: " + request.url, { status: 599 });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export { HttpResponse };
