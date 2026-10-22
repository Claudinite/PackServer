import { describe, expect, it } from "vitest";
import { EmailServiceMail, type MailTelemetry, type SendEmailBinding } from "./email-service";

function setup(failures: number) {
  const events: string[] = [];
  const sent: unknown[] = [];
  let left = failures;
  const binding: SendEmailBinding = {
    async send(message) {
      sent.push(message);
      if (left-- > 0) throw Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" });
      return { messageId: "m-1" };
    },
  };
  const telemetry: MailTelemetry = {
    signal: (name) => void events.push(name),
    ticket: (kind) => void events.push(`ticket:${kind}`),
  };
  const mail = new EmailServiceMail(binding, { from: "noreply@packserver.example", telemetry, failureThreshold: 2 });
  return { mail, events, sent };
}
const msg = { to: "a@example.test", subject: "s", text: "t", html: "<p>t</p>" };

describe("EmailServiceMail", () => {
  it("sends through the binding and emits email.sent", async () => {
    const { mail, events, sent } = setup(0);
    await expect(mail.send(msg)).resolves.toEqual({ id: "m-1" });
    expect(sent).toEqual([{ ...msg, from: "noreply@packserver.example" }]);
    expect(events).toEqual(["email.sent"]);
  });

  it("emits email.failed per failure, the ticket once at the threshold, and rethrows", async () => {
    const { mail, events } = setup(3);
    for (let i = 0; i < 3; i++) await expect(mail.send(msg)).rejects.toMatchObject({ code: "E_SENDER_NOT_VERIFIED" });
    expect(events).toEqual(["email.failed", "email.failed", "ticket:email_failed", "email.failed"]);
  });

  it("resets the count after a success", async () => {
    const { mail, events } = setup(1);
    await expect(mail.send(msg)).rejects.toThrow();
    await mail.send(msg);
    expect(events).toEqual(["email.failed", "email.sent"]);
  });
});
