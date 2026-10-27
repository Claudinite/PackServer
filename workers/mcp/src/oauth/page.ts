import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { SCOPE_DESCRIPTIONS } from "./scopes";

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
} as const;

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 16px}code{overflow-wrap:anywhere}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}label{display:block;margin:.5rem 0}";

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

/** Where the client lives: its metadata document's origin, else the origin its redirect goes to. Never the logo or any client-supplied link. */
export function clientOrigin(consent: Pick<ConsentDescription, "clientId" | "redirectUri">): string {
  for (const candidate of [consent.clientId, consent.redirectUri]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      /* not a URL: try the next */
    }
  }
  return consent.redirectUri;
}

export interface ConsentView {
  consent: ConsentDescription;
  handle: string;
  csrf: string;
  action: string;
  person: string;
}

/** The client's origin leads; its self-chosen name is plain text under an "unverified client" label; no logo is ever shown. */
export function consentPage(view: ConsentView): string {
  const { consent } = view;
  const scopes = consent.scope
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> <code>${escapeHtml(scope)}</code> ${escapeHtml(SCOPE_DESCRIPTIONS[scope] ?? "")}</label>`,
    )
    .join("");
  return shell(
    "Authorize access",
    `<h1>${escapeHtml(clientOrigin(consent))} asks to connect</h1>
<p>Signed in as <strong>${escapeHtml(view.person)}</strong>.</p>
<p>Calling itself <strong>${escapeHtml(consent.clientName)}</strong> (unverified client). It will send you back to <code>${escapeHtml(consent.redirectHost)}</code>.${consent.redirectIsLoopback ? " That address is on this computer: any program here could be listening." : ""}</p>
<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="handle" value="${escapeHtml(view.handle)}">
<input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
<fieldset><legend>Allow it to</legend>${scopes}</fieldset>
<p><button type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny">Deny</button></p>
</form>`,
  );
}

export const errorPage = (message: string): string => shell("Cannot authorize", `<h1>Cannot authorize</h1><p>${escapeHtml(message)}</p>`);
