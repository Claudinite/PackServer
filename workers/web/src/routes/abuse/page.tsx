import { actionFor, findPublicPack, ABUSE_CATEGORIES } from "@packserver/core/moderation";
import { Hono } from "hono";
import { TURNSTILE_ORIGIN } from "@packserver/ui";
import { renderPage } from "../../layout";
import { runtimeOf, type WebEnv } from "../../context";

const REPORT_SCRIPT = `
const form = document.getElementById("abuse-form");
const out = document.getElementById("abuse-result");
const csrf = async () => (await (await fetch("/api/auth/session")).json()).csrf;
const box = document.getElementById("human-check");
const check = { token: null, failed: false, id: null };
window.psTurnstile = () => {
  if (!box || check.id !== null || !window.turnstile) return;
  check.id = window.turnstile.render(box, {
    sitekey: box.getAttribute("data-sitekey"),
    callback: (token) => { check.token = token; },
    "expired-callback": () => { check.token = null; },
    "error-callback": () => { check.failed = true; },
  });
};
const loader = document.getElementById("turnstile-api");
if (loader) loader.addEventListener("error", () => { check.failed = true; });
if (window.turnstile) window.psTurnstile();
const human = async () => {
  const started = Date.now();
  for (;;) {
    if (check.token) {
      const token = check.token;
      check.token = null;
      if (check.id !== null) window.turnstile.reset(check.id);
      return { "cf-turnstile-response": token };
    }
    if (check.failed || !box || (!window.turnstile && Date.now() - started > 10000)) return { "x-turnstile-unavailable": "1" };
    await new Promise((r) => setTimeout(r, 100));
  }
};
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  out.textContent = "Sending...";
  const res = await fetch("/api/abuse/reports", {
    method: "POST",
    headers: { "x-csrf-token": await csrf(), "content-type": "application/json", "idempotency-key": crypto.randomUUID().replaceAll("-", ""), ...(await human()) },
    body: JSON.stringify({ kind: "pack", target: form.dataset.pack, category: form.category.value, details: form.details.value }),
  });
  const body = await res.json();
  out.textContent = res.ok ? "Thank you. A moderator will look at it." : (body.message || "The report was refused.");
});
`;

const APPEAL_SCRIPT = `
const csrf = async () => (await (await fetch("/api/auth/session")).json()).csrf;
for (const form of document.querySelectorAll("form[data-endpoint]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const out = form.querySelector("output");
    const res = await fetch(form.dataset.endpoint, {
      method: "POST",
      headers: { "x-csrf-token": await csrf(), "content-type": "application/json", "idempotency-key": crypto.randomUUID().replaceAll("-", "") },
      body: JSON.stringify({ [form.dataset.field]: form.text.value }),
    });
    const body = await res.json();
    out.textContent = res.ok ? "Sent." : (body.message || "Refused.");
  });
}
`;

const page = new Hono<WebEnv>();

const LABELS: Record<string, string> = {
  malware: "Malware",
  prompt_injection: "Prompt injection",
  secrets_leak: "Secrets leak",
  impersonation: "Impersonation",
  spam: "Spam",
  ip_infringement: "IP infringement",
  other: "Other",
};

/** The target of the pack page's report link: it files nothing. An anonymous visitor is sent to sign in and returns here. */
page.get("/packs/:scope/:name/report-abuse", async (c) => {
  const pack = await findPublicPack(runtimeOf(c).ports.d1, `@${c.req.param("scope").replace(/^@/, "")}/${c.req.param("name")}`);
  if (!pack) return c.notFound();
  if (!c.get("session")) return c.redirect(`/signin?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 303);
  c.header("cache-control", "private, no-store");
  c.set("turnstilePage", true);
  return renderPage(c, {
    title: `Report ${pack.name}`,
    children: (
      <>
        <h1>Report {pack.name}</h1>
        <form id="abuse-form" data-pack={pack.name}>
          <label>Category <select name="category">{ABUSE_CATEGORIES.map((k) => <option value={k}>{LABELS[k]}</option>)}</select></label>
          <label>What is wrong <textarea name="details" required maxlength={4000}></textarea></label>
          <button type="submit">Report</button>
        </form>
        <div id="human-check" data-sitekey={runtimeOf(c).config.turnstileSiteKey ?? ""} />
        <p id="abuse-result" role="status"></p>
        <script nonce={c.get("cspNonce")} dangerouslySetInnerHTML={{ __html: REPORT_SCRIPT }} />
        <script nonce={c.get("cspNonce")} id="turnstile-api" src={`${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit&onload=psTurnstile`} async defer />
      </>
    ),
  });
});

/** The link in a publisher's notice: what was done, with the appeal (or, for a copyright removal, the counter-notice) form. */
page.get("/appeals/:id", async (c) => {
  const session = c.get("session");
  if (!session) return c.redirect(`/signin?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 303);
  const action = await actionFor(runtimeOf(c).ports.d1, c.req.param("id"), session.record.user_id);
  if (!action) return c.notFound();
  c.header("cache-control", "private, no-store");
  const open = action.appeal === null && !action.restored;
  return renderPage(c, {
    title: `Action on ${action.pack}`,
    children: (
      <>
        <h1>{action.version ? `${action.pack} ${action.version}` : action.pack}</h1>
        <p>{action.reason}</p>
        {action.restored ? <p>This has been undone.</p> : null}
        {action.appeal ? <p>{action.appeal.state === "open" ? "Your appeal is with a moderator." : `Your appeal was ${action.appeal.state}. This decision is final.`}</p> : null}
        {open && !action.counter_notice ? (
          <form data-endpoint={`/api/abuse/actions/${action.id}/appeal`} data-field="note">
            <label>Why this should be undone <textarea name="text" required maxlength={4000}></textarea></label>
            <button type="submit">Appeal</button> <output role="status"></output>
          </form>
        ) : null}
        {action.counter_notice && !action.restored && !action.counter_filed ? (
          <form data-endpoint={`/api/abuse/actions/${action.id}/counter-notice`} data-field="notice">
            <label>Counter-notice <textarea name="text" required maxlength={4000}></textarea></label>
            <button type="submit">File counter-notice</button> <output role="status"></output>
          </form>
        ) : null}
        <script nonce={c.get("cspNonce")} dangerouslySetInnerHTML={{ __html: APPEAL_SCRIPT }} />
      </>
    ),
  });
});

export const routes = new Hono().route("/", page);
