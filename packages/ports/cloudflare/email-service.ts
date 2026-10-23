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
