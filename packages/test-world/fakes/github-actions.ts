import type { NetHandler } from "./net";

/** Matches `ROLLBACK_DISPATCH_TOKEN` and `ROLLBACK_REPO` in the admin Worker's `env.test`. */
export const ROLLBACK_TEST_TOKEN = "test-rollback-dispatch-token";
export const ROLLBACK_TEST_REPO = "claudinite/packserver";

export interface RecordedDispatch {
  workflow: string;
  ref: string;
  inputs: Record<string, string>;
  /** Whether the token carried is the one the dispatch is meant to use. */
  authorised: boolean;
}

/** GitHub's workflow-dispatch endpoint for the repository: records each dispatch and answers 204 to an authorised one. */
export class FakeWorkflowDispatch {
  readonly dispatches: RecordedDispatch[] = [];

  handler(): NetHandler {
    return async (request) => {
      const url = new URL(request.url);
      if (url.host !== "api.github.com" || request.method !== "POST") return undefined;
      const match = new RegExp(`^/repos/${ROLLBACK_TEST_REPO}/actions/workflows/([^/]+)/dispatches$`, "i").exec(url.pathname);
      if (!match) return undefined;
      const body = (await request.json()) as { ref: string; inputs?: Record<string, string> };
      const authorised = request.headers.get("authorization") === `Bearer ${ROLLBACK_TEST_TOKEN}`;
      this.dispatches.push({ workflow: match[1]!, ref: body.ref, inputs: body.inputs ?? {}, authorised });
      return authorised ? new Response(null, { status: 204 }) : Response.json({ message: "Bad credentials" }, { status: 401 });
    };
  }

  reset(): void {
    this.dispatches.length = 0;
  }
}
