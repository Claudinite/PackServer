import { actionFor, findPublicPack, ABUSE_CATEGORIES } from "@packserver/core/moderation";
import { Hono } from "hono";
import { renderPage } from "../../layout";
import { runtimeOf, type WebEnv } from "../../context";

const REPORT_SCRIPT = `
const form = document.getElementById("abuse-form");
const out = document.getElementById("abuse-result");
const csrf = async () => (await (await fetch("/api/auth/session")).json()).csrf;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  out.textContent = "Sending...";
  const res = await fetch("/api/abuse/reports", {
    method: "POST",
    headers: { "x-csrf-token": await csrf(), "content-type": "application/json", "idempotency-key": crypto.randomUUID().replaceAll("-", "") },
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
        <p id="abuse-result" role="status"></p>
        <script nonce={c.get("cspNonce")} dangerouslySetInnerHTML={{ __html: REPORT_SCRIPT }} />
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
        <h1>{action.pack} {action.version}</h1>
        <p>{action.reason}</p>
        {action.restored ? <p>The version has been restored.</p> : null}
        {action.appeal ? <p>{action.appeal.state === "open" ? "Your appeal is with a moderator." : `Your appeal was ${action.appeal.state}. This decision is final.`}</p> : null}
        {open && !action.counter_notice ? (
          <form data-endpoint={`/api/abuse/actions/${action.id}/appeal`} data-field="note">
            <label>Why this should be undone <textarea name="text" required maxlength={4000}></textarea></label>
            <button type="submit">Appeal</button> <output role="status"></output>
          </form>
        ) : null}
        {action.counter_notice && !action.restored ? (
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
