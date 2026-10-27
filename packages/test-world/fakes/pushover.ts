import type { NetHandler } from "./net";

export const PUSHOVER_MESSAGES_URL = "https://api.pushover.net/1/messages.json";
/** The values every Worker's `env.test` holds for Pushover: one application, one recipient. */
export const PUSHOVER_TEST_TOKEN = "test-pushover-app-token";
export const PUSHOVER_ARIEL_USER = "test-pushover-user-ariel";

export interface PushedMessage {
  title: string;
  message: string;
  priority: number;
  url: string | null;
}

/**
 * Pushover's messages endpoint. It accepts the one application token and delivers to one user, the way
 * the real service rejects a bad pair, so a Worker that addressed anyone else would see a refusal here.
 */
export class FakePushover {
  readonly delivered: PushedMessage[] = [];
  /** Every request that was not delivered, with why. */
  readonly refused: Array<{ user: string; reason: string }> = [];
  private down = false;

  /** While down the service answers 500, as an outage would. */
  outage(on = true): void {
    this.down = on;
  }

  reset(): void {
    this.delivered.length = 0;
    this.refused.length = 0;
    this.down = false;
  }

  handler(): NetHandler {
    return async (request) => {
      if (request.method !== "POST" || request.url !== PUSHOVER_MESSAGES_URL) return undefined;
      const form = await request.formData();
      const user = String(form.get("user") ?? "");
      if (this.down) {
        this.refused.push({ user, reason: "outage" });
        return Response.json({ status: 0 }, { status: 500 });
      }
      if (form.get("token") !== PUSHOVER_TEST_TOKEN) {
        this.refused.push({ user, reason: "application token" });
        return Response.json({ status: 0, errors: ["application token is invalid"] }, { status: 400 });
      }
      if (user !== PUSHOVER_ARIEL_USER) {
        this.refused.push({ user, reason: "user" });
        return Response.json({ status: 0, errors: ["user identifier is not a valid user"] }, { status: 400 });
      }
      this.delivered.push({ title: String(form.get("title") ?? ""), message: String(form.get("message") ?? ""), priority: Number(form.get("priority") ?? 0), url: (form.get("url") as string | null) ?? null });
      return Response.json({ status: 1, request: crypto.randomUUID() });
    };
  }
}
