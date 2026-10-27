import { DEFAULT_EVENTS } from "@packserver/core/publishing";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { CLIENT_LIB } from "../account/client";
import { ActionDialog } from "../account/dialog";
import { dateOf, stampOf } from "../account/format";
import { ACCOUNT_CSS } from "../account/styles";
import { REGISTRATION_CSS, SETTINGS_CSS } from "../org-settings/styles";
import { signedIn } from "../org-settings/session";
import { GITHUB_CLIENT } from "./client";
import { loadGithub, type PackRow, type Registration, type RunRow, type ScopeBlock } from "./data";
import { workflowFor } from "./workflow";

export const routes = new Hono<WebEnv>();

const VERDICT_TEXT: Record<string, string> = {
  pass: "Passed", warn: "Passed with warnings", hold: "Held for review", fail: "Failed", error: "Stopped by an error",
};

function runStatus(run: Pick<RunRow, "status" | "verdict">): string {
  if (run.status === "queued") return "Waiting to start";
  if (run.status === "running") return "Validating";
  return run.verdict ? (VERDICT_TEXT[run.verdict] ?? run.verdict) : "Finished";
}

const stamp = (iso: string): string => stampOf(Date.parse(iso));

interface FormDefaults {
  repository?: string;
  repository_id?: string;
  repository_owner_id?: string;
  workflow?: string;
  path?: string;
  environment?: string;
  refs?: string[];
  events?: readonly string[];
}

/** The fields of a registration. */
function Fields(props: { values: FormDefaults; editing?: boolean }) {
  const v = props.values;
  const events = v.events ?? DEFAULT_EVENTS;
  return (
    <>
      <label><span>Repository</span><input type="text" name="repository" required placeholder="acme/packs" value={v.repository ?? ""} pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+" autocomplete="off" spellcheck={false} /></label>
      <label><span>Repository id</span><input type="text" name="repository_id" required inputmode="numeric" pattern="[0-9]{1,20}" value={v.repository_id ?? ""} autocomplete="off" /></label>
      <label><span>Repository owner id</span><input type="text" name="repository_owner_id" required inputmode="numeric" pattern="[0-9]{1,20}" value={v.repository_owner_id ?? ""} autocomplete="off" /></label>
      <p class="hint small muted">GitHub's numeric ids; they survive a rename. Read them from <code>https://api.github.com/repos/owner/name</code> (<code>id</code> and <code>owner.id</code>).</p>
      <label><span>Workflow file</span><input type="text" name="workflow" required placeholder=".github/workflows/publish.yml" value={v.workflow ?? ""} autocomplete="off" spellcheck={false} /></label>
      <label><span>Path to the pack in the repository</span><input type="text" name="path" required placeholder="packs/gcp" value={v.path ?? ""} autocomplete="off" spellcheck={false} /></label>
      <label><span>Environment (optional)</span><input type="text" name="environment" value={v.environment ?? ""} autocomplete="off" spellcheck={false} /></label>
      <label><span>{props.editing ? "Ref patterns, one per line (blank keeps the current ones)" : "Ref patterns, one per line (blank for the default)"}</span><textarea name="refs" rows={2} spellcheck={false}>{(v.refs ?? []).join("\n")}</textarea></label>
      <fieldset class="events">
        <legend>Events</legend>
        {DEFAULT_EVENTS.map((e) => <label class="row"><input type="checkbox" name="events" value={e} checked={events.includes(e)} /> <span>{e}</span></label>)}
      </fieldset>
    </>
  );
}

function Registered(props: { scope: ScopeBlock; pack: PackRow; r: Registration; owner: boolean; pins: Parameters<typeof workflowFor>[3] }) {
  const { scope, pack, r, owner } = props;
  const yaml = workflowFor(scope.name, pack.name, r, props.pins);
  const id = `yaml-${r.id}`;
  return (
    <li class="reg-row" data-registration={r.id}>
      <div class="grow">
        <div><strong>{r.repository}</strong> <span class="when">path {r.path}</span></div>
        <dl class="facts small">
          <dt>Workflow</dt><dd><code>{r.workflow}</code></dd>
          <dt>Ref pattern</dt><dd>{r.refs.map((x) => <code>{x}</code>)}</dd>
          <dt>Events</dt><dd>{r.events.join(", ")}</dd>
          <dt>Environment</dt><dd>{r.environment ?? "none"}</dd>
        </dl>
        {r.pending_until ? <p class="small muted">Reserves the name until {dateOf(r.pending_until)}.</p> : null}
        <details class="fold">
          <summary>Workflow YAML</summary>
          <div class="body">
            {yaml.kind === "yaml" ? (
              <>
                <p class="small muted">Save as <code>{r.workflow}</code> in {r.repository}. It pins the Action by commit SHA and cn by version and hash.</p>
                <pre class="snippet" id={id}>{yaml.text}</pre>
                <p class="mt2"><button class="btn" type="button" data-do="copy" data-target={id}>Copy</button></p>
              </>
            ) : (
              <p class="lede">{yaml.why}</p>
            )}
          </div>
        </details>
        {owner ? (
          <details class="fold">
            <summary>Edit</summary>
            <form class="form reg" data-scope={scope.name} data-pack={pack.name} data-id={r.id}>
              <Fields editing values={{ ...r, environment: r.environment ?? "" }} />
              <div><button class="btn" type="submit">Save changes</button></div>
            </form>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function Pack(props: { scope: ScopeBlock; pack: PackRow; pins: Parameters<typeof workflowFor>[3] }) {
  const { scope, pack } = props;
  const owner = scope.role === "owner";
  const full = `@${scope.name}/${pack.name}`;
  return (
    <section class="packrow" data-pack={full}>
      <h3>{pack.pending ? full : <a href={`/packs/${full}`}>{full}</a>}{pack.pending ? <span class="tag"> · name reserved, not published yet</span> : null}</h3>
      {pack.registrations.length === 0 ? <p class="lede">No trusted publisher. Publishing is by upload.</p> : (
        <ul class="list">
          {pack.registrations.map((r) => <Registered scope={scope} pack={pack} r={r} owner={owner} pins={props.pins} />)}
        </ul>
      )}
      {pack.trustedOnly ? <p class="small">Web uploads are off: only trusted publishers can publish this pack.</p> : null}
      {owner && !pack.pending && pack.registrations.length > 0 ? (
        <p class="mt2">
          {pack.trustedOnly
            ? <button class="btn quiet" type="button" data-do="trusted-only-off" data-scope={scope.name} data-pack={pack.name}>Allow web uploads again</button>
            : <button class="btn quiet" type="button" data-do="trusted-only-on" data-scope={scope.name} data-pack={pack.name}>Publish only through trusted publishers</button>}
        </p>
      ) : null}
      {owner && !pack.pending ? (
        <details class="fold">
          <summary>Add a trusted publisher</summary>
          <form class="form reg" data-scope={scope.name} data-pack={pack.name}>
            <Fields values={{}} />
            <div><button class="btn" type="submit">Add</button></div>
          </form>
        </details>
      ) : null}
      <details class="fold section">
        <summary>Recent runs · {pack.runs.length}</summary>
        <div class="body">
          {pack.runs.length === 0 ? <p class="lede">No publish from a workflow yet.</p> : (
            <ul class="list">
              {pack.runs.map((run) => (
                <li>
                  <span class="grow"><a href={`/validation/${run.id}`}>{run.version}</a> <span class="when">{run.kind === "dry-run" ? "dry run · " : ""}{stamp(run.created_at)}</span></span>
                  <span class="run-status" data-status={run.status}>{runStatus(run)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}

function Scope(props: { scope: ScopeBlock; pins: Parameters<typeof workflowFor>[3] }) {
  const { scope } = props;
  return (
    <section class="scopeblock" data-scope={scope.name}>
      <h2>@{scope.name}</h2>
      {scope.packs.length === 0 ? <p class="lede">No packs yet.</p> : scope.packs.map((pack) => <Pack scope={scope} pack={pack} pins={props.pins} />)}
      {scope.role === "owner" ? (
        <details class="fold section">
          <summary>Reserve a name for a pack you have not published</summary>
          <div class="body">
            <p class="lede">The name stays yours for 14 days. A scope holds at most 10 reservations.</p>
            <form class="form reg" data-scope={scope.name} data-new="1">
              <label><span>Pack name</span><input type="text" name="pack" required placeholder="gcp" pattern="[a-z0-9][a-z0-9._\-]*" autocomplete="off" spellcheck={false} /></label>
              <Fields values={{}} />
              <div><button class="btn" type="submit">Reserve and add</button></div>
            </form>
          </div>
        </details>
      ) : null}
    </section>
  );
}

routes.get("/dashboard/github", async (c) => {
  const who = await signedIn(c);
  if (who instanceof Response) return who;
  const scopes = await loadGithub(c, who.userId);
  const pins = c.get("runtime").config.workflowPins;
  const nonce = c.get("cspNonce");
  return renderPage(c, {
    title: "GitHub · Claudinite Packs",
    children: (
      <div class="acct">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS + SETTINGS_CSS + REGISTRATION_CSS }} />
        <div id="ps" data-csrf={who.csrf} data-user={who.userId} />
        <p class="small"><a href="/dashboard">Dashboard</a></p>
        <h1>GitHub</h1>
        <p class="lede">A workflow in your repository publishes a pack with no token to keep: GitHub vouches for the run, and the registry accepts it only from the repository, workflow, ref and event listed here. The registry only reads from GitHub; it never writes to it.</p>
        {scopes.map((scope) => <Scope scope={scope} pins={pins} />)}
        <p class="status" id="ps-status" role="status" />
        <ActionDialog />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: GITHUB_CLIENT }} />
      </div>
    ),
  });
});
