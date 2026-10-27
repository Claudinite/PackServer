import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { CLIENT_LIB } from "../account/client";
import { ActionDialog } from "../account/dialog";
import { ACCOUNT_CSS } from "../account/styles";
import { APPROVE_CLIENT } from "../validation/client";
import { ApprovalSheet } from "../validation/approval";
import { REASON_TEXT } from "./data";
import { plural } from "../account/format";
import { signedIn } from "../org-settings/session";
import { loadDashboard, type Draft, type Need, type PackStatus, type PackSummary } from "./data";

export const routes = new Hono<WebEnv>();

const STATUS_WORD: Record<PackStatus, string> = { live: "Live", working: "Working", "needs-you": "Needs you" };

function Status(props: { pack: PackSummary }) {
  const { pack } = props;
  const word = STATUS_WORD[pack.status];
  return (
    <span class="status-chip" data-status={pack.status} title={pack.why ?? undefined}>
      {pack.status === "needs-you" ? <span class="dot" aria-hidden="true" /> : null}
      {pack.run ? <a href={`/validation/${pack.run}`}>{word}</a> : word}
    </span>
  );
}

function PackRow(props: { pack: PackSummary }) {
  const { pack } = props;
  const name = `@${pack.scope}/${pack.name}`;
  return (
    <li data-pack={name}>
      <span class="grow">
        {pack.version ? <a href={`/packs/${name}`}>{name}</a> : name}
        <span class="when"> {pack.version ?? "not published yet"}</span>
        {pack.why ? <span class="when"> · {pack.why}</span> : null}
      </span>
      {pack.version ? (
        <span class="when">{plural(pack.stars, "star")} · {plural(pack.fetches, "fetch", "fetches")} · {plural(pack.openIssues, "open issue")}</span>
      ) : null}
      <Status pack={pack} />
    </li>
  );
}

function NeedRow(props: { need: Need }) {
  const { need } = props;
  const offer = need.approval;
  return (
    <li data-need={need.kind}>
      <span class="grow">
        {need.text}
        {offer ? (
          <details class="fold">
            <summary>{need.action}</summary>
            <ApprovalSheet runId={offer.runId} pack={offer.pack} version={offer.version} reasons={offer.reasons.map((r) => REASON_TEXT[r] ?? r).join(", ")} sheet={offer.sheet} />
          </details>
        ) : null}
      </span>
      {!offer && need.href && need.action ? <a href={need.href}>{need.action}</a> : null}
    </li>
  );
}

function DraftRow(props: { draft: Draft }) {
  const { draft } = props;
  return (
    <li>
      <span class="grow">{draft.pack} <span class="when">{draft.version}</span></span>
      {draft.expired ? <span class="when">Upload expired</span> : null}
      <a href={draft.href}>{draft.expired ? "Upload again" : "Resume"}</a>
    </li>
  );
}

const DASH_CSS = `
.acct .status-chip { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.acct .status-chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
.acct .head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
`;

routes.get("/dashboard", async (c) => {
  const who = await signedIn(c);
  if (who instanceof Response) return who;
  const data = await loadDashboard(c, who.userId);
  const nonce = c.get("cspNonce");
  const publicPacks = data.packs.filter((p) => p.visibility === "public");
  const privatePacks = data.packs.filter((p) => p.visibility === "private");
  const bottomLine = data.needs.length === 0 ? "Nothing needs you." : `${plural(data.needs.length, "thing")} ${data.needs.length === 1 ? "needs" : "need"} you.`;
  return renderPage(c, {
    title: "Dashboard · Claudinite Packs",
    children: (
      <div class="acct">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS + DASH_CSS }} />
        <div id="ps" data-csrf={who.csrf} />
        <div class="head">
          <h1>Dashboard</h1>
          <a class="btn primary" href="/publish">New pack</a>
        </div>
        {data.empty ? null : (
          <>
            <p class="lede" data-bottom-line>{bottomLine}</p>
            {data.needs.length === 0 ? null : (
              <section id="needs-you">
                <h2>Needs you · {data.needs.length}</h2>
                <ul class="list">{data.needs.map((need) => <NeedRow need={need} />)}</ul>
              </section>
            )}
            {publicPacks.length === 0 ? null : (
              <section id="packs">
                <h2>Packs</h2>
                <ul class="list">{publicPacks.map((pack) => <PackRow pack={pack} />)}</ul>
              </section>
            )}
            {privatePacks.length === 0 ? null : (
              <section id="private">
                <h2>Private packs</h2>
                <ul class="list">{privatePacks.map((pack) => <PackRow pack={pack} />)}</ul>
              </section>
            )}
            {data.drafts.length === 0 ? null : (
              <section id="drafts">
                <h2>Drafts</h2>
                <ul class="list">{data.drafts.map((draft) => <DraftRow draft={draft} />)}</ul>
              </section>
            )}
          </>
        )}
        <p class="status" id="ps-status" role="status" />
        <ActionDialog />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: APPROVE_CLIENT }} />
      </div>
    ),
  });
});
