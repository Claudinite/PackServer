import { issueUrl, muteQuery, renderPage, renderTicket, type AlertFields, type Delivery, type PageId, type TicketKind } from "@packserver/core/alerts";
import type { Mail } from "@packserver/ports";
import type { Telemetry } from "@packserver/core/telemetry";
import type { Pager } from "./pushover";
import type { OutboxItem, RouterStore } from "./store";

export interface DispatchConfig {
  /** Where ops email goes. */
  opsEmail: string;
  /** The admin app's ops page, which a page's notification opens. */
  opsPageUrl: string;
  /** This Worker's public origin, which mute links point at. */
  publicOrigin: string;
  muteKey: () => Promise<string>;
}

export interface Dispatcher {
  deliver(delivery: Delivery, fields: AlertFields, now: number): Promise<void>;
  /** Tries the mails an earlier run could not send; what still fails is held in memory until `flush`. */
  retryOutbox(): Promise<number>;
  /** Writes the outbox once, with everything held since the last flush. KV takes one write a second to a key. */
  flush(): Promise<void>;
}

export function dispatcher(deps: { pager: Pager; mail: Mail; config: DispatchConfig; store: RouterStore; emit: Telemetry["emit"] }): Dispatcher {
  const { pager, mail, config, store, emit } = deps;
  let carried: OutboxItem[] | null = null;
  const pending: OutboxItem[] = [];

  async function sendMail(item: OutboxItem): Promise<boolean> {
    try {
      await mail.send({ to: item.to, subject: item.subject, text: item.text });
      return true;
    } catch {
      return false;
    }
  }

  /** A mail that could not go is kept and tried again next cycle. */
  async function mailOrQueue(item: OutboxItem): Promise<boolean> {
    const ok = await sendMail(item);
    if (!ok) pending.push(item);
    return ok;
  }

  async function page(id: PageId, fields: AlertFields, now: number): Promise<void> {
    const text = renderPage(id, fields);
    let pushed = true;
    try {
      await pager.send({ title: text.title, message: text.message, url: config.opsPageUrl, urlTitle: "Ops page", priority: 1 });
    } catch {
      pushed = false;
    }
    // The email copy carries the signed mute link, which a push notification has no room for.
    const mute = `${config.publicOrigin}/hooks/mute?${await muteQuery(await config.muteKey(), id, now)}`;
    const mailed = await mailOrQueue({ ticket: "page", to: config.opsEmail, subject: text.title, text: `${text.message}\n\nMute this page for four hours: ${mute}`, queuedAt: now });
    emit("monitoring.alert_sent", { page: id, channel: "pushover", ok: pushed });
    emit("monitoring.alert_sent", { page: id, channel: "email", ok: mailed });
    if (!pushed && !mailed) throw new Error(`neither channel took ${id}`);
  }

  async function ticket(source: { page: PageId } | { ticket: TicketKind }, fields: AlertFields, reason: string, now: number): Promise<void> {
    const text = "page" in source ? renderPage(source.page, fields) : renderTicket(source.ticket, fields);
    const subject = "page" in source ? `[ticket] ${text.title}` : text.title;
    const issueTitle = "page" in source ? `[${source.page}] ${text.message.split(".")[0]}` : (text as ReturnType<typeof renderTicket>).issueTitle;
    const link = issueUrl(issueTitle, `${text.message}\n\nRaised as a ticket: ${reason}.`);
    const name = "page" in source ? source.page : source.ticket;
    const mailed = await mailOrQueue({ ticket: "page" in source ? "page" : source.ticket, to: config.opsEmail, subject, text: `${text.message}\n\nOpen the ticket: ${link}`, queuedAt: now });
    emit("monitoring.alert_sent", { ticket: name, channel: "email", ok: mailed });
  }

  return {
    async deliver(delivery, fields, now) {
      if (delivery.kind === "page") return page(delivery.page, fields, now);
      return ticket(delivery.source, fields, delivery.reason, now);
    },
    async retryOutbox() {
      const items = carried ?? (await store.outbox());
      if (items.length === 0) return 0;
      const remaining: OutboxItem[] = [];
      for (const item of items) if (!(await sendMail(item))) remaining.push(item);
      carried = remaining;
      return items.length - remaining.length;
    },
    async flush() {
      if (carried === null && pending.length === 0) return;
      const held = [...(carried ?? (await store.outbox())), ...pending];
      carried = null;
      pending.length = 0;
      await store.putOutbox(held);
    },
  };
}
