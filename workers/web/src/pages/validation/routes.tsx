import { csrfTokenFor } from "@packserver/http";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { CLIENT_LIB } from "../account/client";
import { ActionDialog } from "../account/dialog";
import { stampOf } from "../account/format";
import { ACCOUNT_CSS } from "../account/styles";
import { notFoundPage } from "../home/not-found";
import { REASON_TEXT } from "../dashboard/data";
import { ApprovalSheet } from "./approval";
import { APPROVE_CLIENT, VALIDATION_CLIENT } from "./client";
import { loadRun, logOf, verdictSentence, type RunPage } from "./data";

export const routes = new Hono<WebEnv>();

const APPEAL_MAX = 2000;
const VERDICT_WORD: Record<string, string> = { pass: "Passed", warn: "Passed with warnings", hold: "Held for review", fail: "Failed", error: "Stopped by an error" };
const CSS = `
.acct .finding { padding: 8px 0; }
.acct .finding + .finding { border-top: 1px solid var(--line); }
.acct .finding code { overflow-wrap: anywhere; }
.acct blockquote { margin: 4px 0 0; padding-left: 12px; border-left: 1px solid var(--line-strong); color: var(--grey-1); overflow-wrap: anywhere; }
.acct .actions { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 16px; align-items: baseline; }
.acct textarea { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; padding: 8px 12px; min-width: 0; width: 100%; box-sizing: border-box; }
`;

const wordFor = (run: { status: string; verdict: string | null }): string => (run.status === "finished" ? (run.verdict ? (VERDICT_WORD[run.verdict] ?? run.verdict) : "Finished") : run.status === "queued" ? "Waiting to start" : "Validating");

function Findings(props: { run: RunPage }) {
  const { run } = props;
  if (run.findings.length === 0) return <p class="lede">{run.unreadable ? "The report could not be read." : "No findings."}</p>;
  return (
    <ul class="list">
      {run.findings.map((f) => (
        <li class="finding" data-class={f.class}>
          <span class="grow">
            <strong>{f.class === "fail" ? "Fails" : f.class === "hold" ? "Held" : "Warns"}</strong> <code>{f.rule}</code>
            {f.file ? <span class="when"> {f.file}{f.line === null ? "" : `:${f.line}`}</span> : null}
            <br />
            {f.hint}
            {f.quote ? <blockquote>{f.quote}</blockquote> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Actions(props: { run: RunPage }) {
  const { run } = props;
  const pack = `@${run.scope}/${run.pack}`;
  const rejected = run.decision?.kind === "reject";
  const retry = run.role !== null && run.status === "finished" && (run.verdict === "fail" || run.verdict === "error" || rejected);
  return (
    <div class="actions">
      {retry ? <a class="btn" href={`/publish?pack=${encodeURIComponent(pack)}`}>{run.verdict === "error" ? "Re-run" : "Resubmit"}</a> : null}
      <a href={`/validation/${run.id}/log`}>Download log</a>
    </div>
  );
}

routes.get("/validation/:id", async (c) => {
  const run = await loadRun(c, c.req.param("id"));
  if (!run) return notFoundPage(c);
  c.header("cache-control", "private, no-store");
  const nonce = c.get("cspNonce");
  const live = c.get("session");
  const csrf = live ? await csrfTokenFor(live) : "";
  const canAppeal = run.role !== null && (run.decision?.kind === "reject" || run.decision?.kind === "quarantine_publisher") && run.appeal === null;
  const pack = `@${run.scope}/${run.pack}`;
  return renderPage(c, {
    title: `${pack} ${run.version} · Claudinite Packs`,
    children: (
      <div class="acct" id="run" data-run={run.id} data-status={run.status}>
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS + CSS }} />
        <div id="ps" data-csrf={csrf} />
        <p class="small"><a href="/dashboard">Dashboard</a></p>
        <h1>{pack} <span class="when">{run.version}</span></h1>
        <p class="lede" id="verdict">{verdictSentence(run)}</p>
        {run.appeal ? <p class="small muted">Appeal {run.appeal.state === "open" ? "sent; a person at PackServer will read it" : run.appeal.state === "upheld" ? "upheld" : "denied"}.</p> : null}
        {run.status === "finished" ? null : <ul class="list" id="steps">{run.milestones.map((m) => <li>{m.step} · {m.outcome}</li>)}</ul>}
        <Actions run={run} />
        {run.sheet ? (
          <section>
            <h2>Approve</h2>
            <ApprovalSheet runId={run.id} pack={pack} version={run.version} reasons={run.sheet.reasons.map((r) => REASON_TEXT[r] ?? r).join(", ")} sheet={run.sheet.view} />
          </section>
        ) : null}
        {canAppeal ? (
          <section>
            <h2>Appeal</h2>
            <p class="lede">You can appeal once. A person reads the note; no model does.</p>
            <form class="form" id="appeal">
              <label><span>What should the reviewer know?</span><textarea name="note" rows={4} maxlength={APPEAL_MAX} required /></label>
              <div><button class="btn" type="submit">Send appeal</button></div>
            </form>
          </section>
        ) : null}
        {run.status !== "finished" ? null : (
          <>
            <details class="fold section" open={run.verdict === "fail"}>
              <summary>Show report · {run.findings.length}</summary>
              <div class="body">
                <Findings run={run} />
                {run.milestones.length === 0 ? null : <p class="small muted">Steps: {run.milestones.map((m) => `${m.step} ${m.outcome}`).join(", ")}.</p>}
              </div>
            </details>
          </>
        )}
        {run.previous.length === 0 ? null : (
          <details class="fold section">
            <summary>Previous runs · {run.previous.length}</summary>
            <div class="body">
              <ul class="list">
                {run.previous.map((p) => (
                  <li><span class="grow"><a href={`/validation/${p.id}`}>{p.version}</a> <span class="when">{stampOf(Date.parse(p.created_at))}</span></span><span>{wordFor(p)}</span></li>
                ))}
              </ul>
            </div>
          </details>
        )}
        <p class="status" id="ps-status" role="status" />
        <ActionDialog />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: VALIDATION_CLIENT }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: APPROVE_CLIENT }} />
      </div>
    ),
  });
});

routes.get("/validation/:id/state", async (c) => {
  const run = await loadRun(c, c.req.param("id"));
  if (!run) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" });
  return c.json({ status: run.status, verdict: run.verdict, milestones: run.milestones.map((m) => ({ step: m.step, outcome: m.outcome })) }, 200, { "cache-control": "private, no-store" });
});

routes.get("/validation/:id/log", async (c) => {
  const run = await loadRun(c, c.req.param("id"));
  if (!run) return c.json({ error: "not_found" }, 404, { "cache-control": "no-store" });
  return c.body(logOf(run), 200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="validation-${run.id.replace(/[^A-Za-z0-9_-]/g, "")}.log"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
});
