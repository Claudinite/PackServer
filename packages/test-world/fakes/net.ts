import { http } from "msw";
import { setupServer, type SetupServer } from "msw/node";
import { Agent, setGlobalDispatcher } from "undici";
import type { InvocationView } from "../world/recorder";

/** A fake for one outside host: answers a request it owns, returns nothing for any other. */
export type NetHandler = (request: Request) => Promise<Response | undefined> | Response | undefined;

/**
 * Every outbound `fetch` of every Worker passes through Node, so one interception point
 * enforces that anything outside is faked: a host no handler claims fails the call.
 */
export class Net {
  private readonly handlers: NetHandler[] = [];
  private readonly seen: InvocationView[] = [];
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
        for (const handler of this.handlers) {
          const res = await handler(request.clone() as Request);
          if (res) {
            this.seen.push({ kind: "http", target: url.host, op: `${request.method} ${url.pathname}`, effect: "external_side_effect", seenBy: "harness" });
            return res;
          }
        }
        return undefined;
      }),
    );
    this.server.listen({ onUnhandledFrame: "error" });
  }

  reset(): void {
    this.seen.length = 0;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
  }
}
