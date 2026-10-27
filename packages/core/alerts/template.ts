import { OPS_REPOSITORY, PAGES, TICKET_TITLES, type PageId, type TicketKind } from "./catalogue";

/** The only things an alert may say beyond its catalogue text: counts, a tier and the time the judge raised it. No names, no exception text, no URL. */
export interface AlertFields {
  count?: number;
  tier?: number;
  /** ISO time from the judge's clock. */
  at?: string;
  /** The automatic action was tried and did not happen, so the page must not say it is done. */
  actionFailed?: boolean;
  /** The signal did not carry what the action needs, so none could be tried. */
  noAction?: boolean;
}

export interface Rendered {
  title: string;
  message: string;
}

const number = (n: number | undefined): string | null => (n === undefined || !Number.isFinite(n) ? null : String(Math.max(0, Math.trunc(n))));
const time = (at: string | undefined): string | null => (at !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(at) ? at : null);

/** Anything outside plain printable text is dropped, so a catalogue edit cannot smuggle markup or control characters into a page. */
export function escapeText(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, "").replace(/[<>&"'`]/g, "");
}

function details(fields: AlertFields): string[] {
  const parts: string[] = [];
  const count = number(fields.count);
  const tier = number(fields.tier);
  const at = time(fields.at);
  if (count !== null) parts.push(`Events: ${count}.`);
  if (tier !== null) parts.push(`Tier: ${tier}.`);
  if (at !== null) parts.push(`Raised: ${at}.`);
  return parts;
}

export function renderPage(id: PageId, fields: AlertFields = {}): Rendered {
  const def = PAGES[id];
  const done = fields.actionFailed === true ? "The automatic action FAILED, do it by hand" : fields.noAction === true ? "No automatic action was possible, do it by hand" : `Already done: ${def.done}`;
  return {
    title: escapeText(`${def.id} (${def.runbook})`),
    message: escapeText([`${def.title}.`, `${done}.`, `First tap: ${def.tap} on the ops page.`, ...details(fields)].join(" ")),
  };
}

export function renderTicket(kind: TicketKind, fields: AlertFields = {}): Rendered & { issueTitle: string } {
  const title = escapeText(TICKET_TITLES[kind]);
  return {
    title: escapeText(`ticket.${kind}`),
    issueTitle: `[${kind}] ${title}`,
    message: escapeText([`${title}.`, ...details(fields)].join(" ")),
  };
}

/** A URL GitHub's new-issue form opens pre-filled; a person clicks it, and nothing here writes to GitHub. */
export const ISSUE_URL_LIMIT = 6000;

export function issueUrl(title: string, body: string, repository: string = OPS_REPOSITORY): string {
  const build = (text: string): string => `https://github.com/${repository}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
  let text = body;
  while (build(text).length > ISSUE_URL_LIMIT && text.length > 0) text = text.slice(0, Math.floor(text.length * 0.8));
  return build(text);
}
