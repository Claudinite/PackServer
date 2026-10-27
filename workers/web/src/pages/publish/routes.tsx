import { MAX_UPLOAD_BYTES } from "@packserver/core/publishing";
import { CATEGORIES } from "@packserver/core/search";
import { PRICES, Price } from "@packserver/ui";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { CLIENT_LIB } from "../account/client";
import { ActionDialog } from "../account/dialog";
import { ACCOUNT_CSS } from "../account/styles";
import { signedIn } from "../org-settings/session";
import { api } from "./api";
import { WIZARD_CLIENT } from "./client";
import { loadWizard } from "./data";
import { WIZARD_CSS } from "./styles";

export const routes = new Hono<WebEnv>();
routes.route("/", api);

const STEPS = [
  ["source", "Source"],
  ["check", "Check"],
  ["listing", "Listing"],
  ["visibility", "Visibility"],
  ["publish", "Publish"],
] as const;

/** JSON that is safe inside a script element: no `<` can close the element or open a comment. */
const inert = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

routes.get("/publish", async (c) => {
  const who = await signedIn(c);
  if (who instanceof Response) return who;
  const wanted = c.req.query("pack");
  const state = await loadWizard(c, who.userId, wanted);
  c.set("directUploadPage", true);
  const nonce = c.get("cspNonce");
  const maxMiB = MAX_UPLOAD_BYTES / (1024 * 1024);
  const [scope = "", name = ""] = state.pack ? [state.pack.scope, state.pack.name] : [];
  return renderPage(c, {
    title: "Publish a pack · Claudinite Packs",
    children: (
      <div class="acct wiz" id="wiz">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS + WIZARD_CSS }} />
        <div id="ps" data-csrf={who.csrf} />
        <script type="application/json" id="wiz-state" dangerouslySetInnerHTML={{ __html: inert({ ...state, maxBytes: MAX_UPLOAD_BYTES, categories: CATEGORIES }) }} />
        <p class="small"><a href="/dashboard">Dashboard</a></p>
        <h1>Publish a pack</h1>
        <noscript><p class="lede">Publishing here needs JavaScript to upload and check your archive.</p></noscript>
        <ol class="steps" aria-label="Steps">
          {STEPS.map(([id, label]) => <li data-for={id}>{label}</li>)}
        </ol>

        <section data-step="source">
          <p class="lede" data-lede>Choose the archive to publish.</p>
          {state.scopes.length === 0 ? (
            <p class="err">You do not publish to any scope yet. Create an organisation or finish setting up your account first.</p>
          ) : (
            <form class="form" id="source-form" autocomplete="off">
              <div class="row">
                {state.scopes.length === 1 ? (
                  <span class="at">@{state.scopes[0]}</span>
                ) : (
                  <select name="scope" aria-label="Scope">{state.scopes.map((s) => <option value={s} selected={s === scope}>@{s}</option>)}</select>
                )}
                <span aria-hidden="true">/</span>
                <input type="text" name="name" aria-label="Pack name" placeholder="pack-name" value={name} required spellcheck={false} />
              </div>
              <label><span>Version</span><input type="text" name="version" placeholder="1.0.0" required spellcheck={false} /></label>
              <fieldset class="choice">
                <legend class="small muted">Where the pack comes from</legend>
                <label class="inline"><input type="radio" name="source" value="upload" checked /> Upload an archive</label>
                <label class="inline"><input type="radio" name="source" value="repo" /> From a GitHub repository</label>
              </fieldset>
              <div data-source="upload">
                <label><span>Archive (.tar.zst, at most {maxMiB} MiB)</span><input type="file" name="archive" accept=".zst,.tar.zst,application/zstd" /></label>
                <p class="small muted" id="source-file" />
              </div>
              <p data-source="repo" hidden>
                Register the repository, path and workflow on <a href="/dashboard/github">the GitHub page</a>. Each matching push validates and publishes it; there is nothing to upload here.
              </p>
              <p class="small muted" id="price" hidden>
                New pack: <Price amount={PRICES.newPack.amount} unit={PRICES.newPack.unit} />
              </p>
              <p class="small" id="draft-note" hidden />
              <p class="err" id="source-error" role="alert" hidden />
              <div class="row"><button class="btn primary" type="submit" id="source-next">Check it</button></div>
            </form>
          )}
        </section>

        <section data-step="check" hidden>
          <p class="lede" id="check-line" role="status">Checking.</p>
          <ul class="list log" id="check-log" />
          <p class="small muted" id="check-draft" />
          <details class="fold" id="check-report" hidden>
            <summary id="check-report-summary">Report</summary>
            <ul class="list" id="check-findings" />
          </details>
          <p class="err" id="check-error" role="alert" hidden />
          <div class="row">
            <button class="btn" type="button" data-back="source">Choose another archive</button>
            <button class="btn primary" type="button" id="check-next" disabled>Next</button>
            <button class="btn" type="button" id="check-retry" hidden>Try again</button>
          </div>
        </section>

        <section data-step="listing" hidden>
          <p class="lede" id="listing-line">This is how the pack will be listed.</p>
          <dl class="facts">
            <dt>Pack</dt><dd id="listing-pack" />
            <dt>Version</dt><dd id="listing-version" />
            <dt>Source</dt><dd id="listing-source">No public repo</dd>
          </dl>
          <label class="inline"><input type="checkbox" id="no-repo" /> This pack has no public source repository. The listing says so.</label>
          <details class="fold">
            <summary>Category and tags</summary>
            <p class="small muted">They come from your pack's manifest. The category must be one of: {CATEGORIES.join(", ")}. Anything else fails the check.</p>
          </details>
          <div class="row">
            <button class="btn" type="button" data-back="check">Back</button>
            <button class="btn primary" type="button" id="listing-next" disabled>Next</button>
          </div>
        </section>

        <section data-step="visibility" hidden>
          <p class="lede" id="visibility-line">Who can fetch this pack.</p>
          <fieldset class="choice">
            <label class="inline"><input type="radio" name="visibility" value="public" /> Public</label>
            <label class="inline"><input type="radio" name="visibility" value="private" /> Private</label>
          </fieldset>
          <p class="small muted" id="visibility-note" />
          <div class="row">
            <button class="btn" type="button" data-back="listing">Back</button>
            <button class="btn primary" type="button" id="visibility-next">Next</button>
          </div>
        </section>

        <section data-step="publish" hidden>
          <p class="lede" id="publish-line">Ready to publish.</p>
          <p class="small muted" id="publish-detail" />
          <p class="err" id="publish-error" role="alert" hidden />
          <ul class="list log" id="publish-log" hidden />
          <div class="row" id="publish-actions">
            <button class="btn" type="button" data-back="visibility" id="publish-back">Back</button>
            <button class="btn primary" type="button" id="publish-go">Publish with your passkey</button>
          </div>
          <p id="publish-after" hidden />
        </section>

        <p class="status" id="ps-status" role="status" />
        <ActionDialog />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: WIZARD_CLIENT }} />
      </div>
    ),
  });
});
