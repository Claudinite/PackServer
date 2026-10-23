import type { SignalName } from "@packserver/schema";
import type { Mail, MailMessage } from "../src/ports";

/** The Cloudflare Email Service `send_email` binding (structured builder form). */
export interface SendEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

export interface MailTelemetry {
  signal(name: SignalName, fields: Record<string, string | number>): void;
  /** The ticket raised once consecutive failures reach the threshold. */
  ticket(kind: "email_failed", fields: Record<string, string | number>): void;
}

/** Errors about one recipient say nothing about the provider's health. */
const RECIPIENT_ERRORS = new Set(["E_RECIPIENT_SUPPRESSED", "E_RECIPIENT_NOT_ALLOWED"]);

export interface EmailServiceOptions {
  from: string;
  telemetry: MailTelemetry;
  /** Consecutive failures before the `email_failed` ticket is raised. */
  failureThreshold: number;
}

/**
 * The one mail provider. A failed send is reported and rethrown; there is no
 * retry against another provider (switching provider is a config change).
 */
export class EmailServiceMail implements Mail {
  private consecutiveFailures = 0;

  constructor(
    private readonly binding: SendEmailBinding,
    private readonly options: EmailServiceOptions,
  ) {}

  async send(message: MailMessage): Promise<{ id: string }> {
    const { telemetry, from, failureThreshold } = this.options;
    try {
      const result = await this.binding.send({
        to: message.to,
        from,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      });
      this.consecutiveFailures = 0;
      telemetry.signal("email.sent", { id: result.messageId });
      return { id: result.messageId };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const providerFault = !(typeof code === "string" && RECIPIENT_ERRORS.has(code));
      if (providerFault) this.consecutiveFailures += 1;
      const fields = {
        code: typeof code === "string" ? code : "unknown",
        consecutive_failures: this.consecutiveFailures,
      };
      telemetry.signal("email.failed", fields);
      if (providerFault && this.consecutiveFailures === failureThreshold) telemetry.ticket("email_failed", fields);
      throw error;
    }
  }
}

/** Where `env.test` posts a message instead of sending it; the world's mail fake answers at this address. */
export const TEST_MAIL_URL = "https://mail.test.invalid/send";

/**
 * Email Service in staging and production; under `env.test` a POST to the world's mail fake, chosen
 * by `ENVIRONMENT` and never by the binding. A deployed Worker without its binding fails when it
 * first sends, naming what is missing.
 */
export function mailPort(
  environment: string,
  binding: SendEmailBinding | undefined,
  options: { from: string | undefined; telemetry: MailTelemetry; failureThreshold: number },
  fetcher: typeof fetch = fetch,
): Mail {
  if (environment === "test") {
    return {
      async send(message) {
        const res = await fetcher(TEST_MAIL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
        if (!res.ok) throw new Error(`mail fake answered ${res.status}`);
        return (await res.json()) as { id: string };
      },
    };
  }
  let sender: EmailServiceMail | undefined;
  return {
    async send(message) {
      if (!binding || !options.from) throw new Error("mail is not configured: the EMAIL binding and MAIL_FROM are required outside env.test");
      sender ??= new EmailServiceMail(binding, { from: options.from, telemetry: options.telemetry, failureThreshold: options.failureThreshold });
      return sender.send(message);
    },
  };
}
