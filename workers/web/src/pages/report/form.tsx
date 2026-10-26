import { BUG_TYPES, SEVERITIES } from "@packserver/core/reports";
import type { Context } from "hono";
import { renderPage } from "../../layout";

const label = (value: string) => value.replace("_", " ");

/**
 * Files nothing itself: it uploads attachments, files the report through the JSON API with the session's token,
 * and shows the GitHub address to open when the pack has a linked repository.
 */
const SCRIPT = `
const form = document.getElementById("report-form");
const out = document.getElementById("report-result");
const similar = document.getElementById("similar");
const pack = form.dataset.pack;
const say = (text) => { out.textContent = text; };
const csrf = async () => (await (await fetch("/api/auth/session")).json()).csrf;
form.title.addEventListener("blur", async () => {
  similar.replaceChildren();
  if (form.title.value.trim().length < 3) return;
  const res = await fetch("/api/packs/" + pack + "/reports/similar?title=" + encodeURIComponent(form.title.value));
  if (!res.ok) return;
  for (const item of (await res.json()).similar) {
    const li = document.createElement("li");
    li.textContent = item.title + " (" + item.status + ")";
    similar.append(li);
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  say("Sending...");
  const token = await csrf();
  const headers = { "x-csrf-token": token };
  const ids = [];
  for (const file of form.attachments.files) {
    const res = await fetch("/api/packs/" + pack + "/reports/attachments?name=" + encodeURIComponent(file.name), { method: "POST", headers, body: file });
    const body = await res.json();
    if (!res.ok) return say(file.name + ": " + (body.message || "refused"));
    ids.push(body.attachment.id);
  }
  const data = Object.fromEntries(new FormData(form).entries());
  delete data.attachments;
  if (data.kind === "security") delete data.type;
  const res = await fetch("/api/packs/" + pack + "/reports", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID().replaceAll("-", "") },
    body: JSON.stringify({ ...data, attachment_ids: ids }),
  });
  const body = await res.json();
  if (!res.ok) return say(body.message || "The report was refused.");
  out.replaceChildren();
  out.append(document.createTextNode("Report filed. "));
  if (body.new_issue_url) {
    const a = document.createElement("a");
    a.href = body.new_issue_url;
    a.rel = "noopener";
    a.textContent = "Open the pre-filled GitHub issue under your own account";
    out.append(a);
  }
});
`;

export function renderReportPage(c: Context, props: { pack: string; signedIn: boolean }) {
  const next = encodeURIComponent(new URL(c.req.url).pathname);
  return renderPage(c, {
    title: `Report a problem with ${props.pack}`,
    children: (
      <>
        <h1>Report a problem with {props.pack}</h1>
        {!props.signedIn ? (
          <p><a href={`/signin?next=${next}`}>Sign in</a> to report a problem.</p>
        ) : (
          <>
            <form id="report-form" data-pack={props.pack}>
              <label>Kind <select name="kind"><option value="bug">Bug</option><option value="security">Security (private)</option></select></label>
              <label>Version <input name="version" required pattern="[0-9]+\.[0-9]+\.[0-9]+.*" /></label>
              <label>Type <select name="type">{BUG_TYPES.map((t) => <option value={t}>{label(t)}</option>)}</select></label>
              <label>Severity <select name="severity">{SEVERITIES.map((s) => <option value={s}>{s}</option>)}</select></label>
              <label>Title <input name="title" required maxlength={140} /></label>
              <ul id="similar" aria-label="Similar open issues"></ul>
              <label>Steps to reproduce <textarea name="repro" required maxlength={8000}></textarea></label>
              <label>Environment <textarea name="environment" required maxlength={2000}></textarea></label>
              <label>Attachments (images or text, 5 MB each) <input type="file" name="attachments" multiple /></label>
              <p>A security report stays private to the pack's owners, maintainers and registry security, and is disclosed after 90 days.</p>
              <button type="submit">Send report</button>
            </form>
            <p id="report-result" role="status"></p>
            <script nonce={c.get("cspNonce")} dangerouslySetInnerHTML={{ __html: SCRIPT }} />
          </>
        )}
      </>
    ),
  });
}
