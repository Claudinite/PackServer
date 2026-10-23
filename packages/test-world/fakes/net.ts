import { http, HttpResponse, passthrough } from "msw";
import { setupServer, type SetupServer } from "msw/node";
import { Agent, setGlobalDispatcher } from "undici";
import type { InvocationView } from "../world/recorder";

/** A fake for one outside host: answers a request it owns, returns nothing for any other. */
export type NetHandler = (request: Request) => Promise<Response | undefined> | Response | undefined;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HARNESS_PROXY_PATH = "/cdn-cgi/local/platform-proxy";

/** The test process reaching a Worker's binding (D1, R2) through the harness's own local proxy is not the system calling out. */
export const isHarnessProxy = (url: URL): boolean => LOOPBACK.has(url.hostname) && url.pathname.startsWith(HARNESS_PROXY_PATH);

/**
 * Every outbound `fetch` of every Worker passes through Node, so one interception point
 * enforces that anything outside is faked: a host no handler claims fails the call.
 */
export class Net {
  private readonly handlers: NetHandler[] = [];
  private readonly seen: InvocationView[] = [];
  private readonly refused: string[] = [];
  private baseHandlers = 0;
  private server: SetupServer | undefined;

  use(handler: NetHandler): void {
    this.handlers.push(handler);
  }

  /** What the wire carried since the last `reset`, before any redaction. */
  requests(): InvocationView[] {
    return [...this.seen];
  }

  listen(): void {
    // Importing wrangler installs undici's proxy-aware dispatcher when HTTPS_PROXY is set; MSW would
    // then see CONNECT frames instead of requests, and the Workers must never reach a real proxy anyway.
    setGlobalDispatcher(new Agent());
    this.server = setupServer(
      http.all("*", async ({ request }) => {
        const url = new URL(request.url);
        if (isHarnessProxy(url)) return passthrough();
        for (const handler of this.handlers) {
          const res = await handler(request.clone() as Request);
          if (res) {
            this.seen.push({ kind: "http", target: url.host, op: `${request.method} ${url.pathname}`, effect: "external_side_effect", seenBy: "harness" });
            return res;
          }
        }
        this.refused.push(`${request.method} ${request.url}`);
        return HttpResponse.error();
      }),
    );
    this.server.listen({ onUnhandledFrame: "error" });
  }

  /** Calls no fake claimed since the last `reset`; the scenario that made them fails. */
  unfaked(): string[] {
    return [...this.refused];
  }

  reset(): void {
    this.seen.length = 0;
    this.refused.length = 0;
    this.handlers.length = this.baseHandlers;
  }

  /** Handlers registered before this call survive every `reset`; later ones are per scenario. */
  freeze(): void {
    this.baseHandlers = this.handlers.length;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
  }
}
