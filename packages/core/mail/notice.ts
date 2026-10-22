import type { MailMessage } from "@packserver/ports";

/** What a template says; the renderer turns it into the plain-text and HTML parts. */
export interface Notice {
  subject: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  /** Further links, one per item the notice lists. */
  links?: Array<{ label: string; url: string }>;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function render(notice: Notice): Pick<MailMessage, "subject" | "text" | "html"> {
  const links = [...(notice.links ?? []), ...(notice.action ? [notice.action] : [])];
  if (links.some((l) => !l.url.startsWith("https://"))) {
    throw new Error("notice links must be https");
  }
  const textParts = [...notice.paragraphs, ...links.map((l) => `${l.label}: ${l.url}`)];
  const htmlParts = [
    ...notice.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...links.map((l) => `<p><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></p>`),
  ];
  return {
    subject: notice.subject,
    text: `${textParts.join("\n\n")}\n`,
    html: `<!doctype html><html><body>${htmlParts.join("")}</body></html>`,
  };
}
