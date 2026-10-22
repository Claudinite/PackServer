import type { MailMessage } from "@packserver/ports";

/** What a template says; the renderer turns it into the plain-text and HTML parts. */
export interface Notice {
  subject: string;
  paragraphs: string[];
  action?: { label: string; url: string };
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function render(notice: Notice): Pick<MailMessage, "subject" | "text" | "html"> {
  if (notice.action && !notice.action.url.startsWith("https://")) {
    throw new Error("notice action links must be https");
  }
  const textParts = [...notice.paragraphs];
  if (notice.action) textParts.push(`${notice.action.label}: ${notice.action.url}`);
  const htmlParts = notice.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`);
  if (notice.action) {
    htmlParts.push(`<p><a href="${escapeHtml(notice.action.url)}">${escapeHtml(notice.action.label)}</a></p>`);
  }
  return {
    subject: notice.subject,
    text: `${textParts.join("\n\n")}\n`,
    html: `<!doctype html><html><body>${htmlParts.join("")}</body></html>`,
  };
}
