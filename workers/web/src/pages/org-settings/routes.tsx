import { MFA_POLICIES } from "@packserver/core/identity";
import { Price, PRICES } from "@packserver/ui";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { CLIENT_LIB } from "../account/client";
import { ActionDialog } from "../account/dialog";
import { dateOf } from "../account/format";
import { ACCOUNT_CSS } from "../account/styles";
import { notFoundPage } from "../home/not-found";
import { ORG_CLIENT } from "./client";
import { loadOrgSettings, type OrgSettings } from "./data";
import { signedIn } from "./session";
import { SETTINGS_CSS } from "./styles";

export const routes = new Hono<WebEnv>();

const POLICY_LABEL: Record<(typeof MFA_POLICIES)[number], string> = {
  none: "No requirement",
  mfa: "Require MFA",
  passkey: "Passkeys only",
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function Verification(props: { org: OrgSettings }) {
  const { org } = props;
  const owner = org.role === "owner";
  const { domain, github, application } = org;
  const missing = org.missing.map((m) => (m === "proof" ? "prove a domain or a GitHub organisation" : "require MFA or passkeys only for everyone acting for the organisation"));
  const renewable = application.renewable_at === null || Date.parse(application.renewable_at) <= org.now;
  return (
    <section id="verification">
      <h2>Verification</h2>

      <h3>Domain</h3>
      {domain.proven ? (
        <p class="lede">
          <strong>{domain.proven.domain}</strong> is proven{domain.proven.method === "txt" ? " by a DNS record" : domain.proven.method === "well-known" ? " by a file on the site" : ""}
          {domain.proven.since ? `, since ${dateOf(domain.proven.since)}` : ""}.
          {domain.proven.transferred_at ? ` The domain was held by another scope within the last year (${dateOf(domain.proven.transferred_at)}).` : ""}
        </p>
      ) : (
        <p class="lede">No domain is proven yet.</p>
      )}
      {domain.pending.map((c) => (
        <div class="record" data-challenge={c.id}>
          <p>To prove <strong>{c.domain}</strong>, publish either record, then check.</p>
          <p class="small muted">DNS TXT record</p>
          <pre class="snippet">{`${c.txt.name}  TXT  ${c.txt.value}`}</pre>
          <p class="small muted">or a file at {c.wellKnown.url} containing</p>
          <pre class="snippet">{c.wellKnown.body}</pre>
          {owner ? <p class="mt2"><button class="btn" type="button" data-do="check-domain" data-id={c.id}>Check now</button></p> : null}
        </div>
      ))}
      {owner && !domain.proven ? (
        <form class="form" id="prove-domain">
          <label><span>Domain</span><input type="text" name="domain" required placeholder="acme.com" autocomplete="off" spellcheck={false} /></label>
          <div><button class="btn" type="submit">Prove a domain</button></div>
        </form>
      ) : null}

      <h3 class="mt2">GitHub organisation</h3>
      {github ? (
        <p class="lede">
          <strong>{github.org}</strong> is proven {github.method === "app" ? "by the installed GitHub App" : "by an owner's sign-in"}, since {dateOf(github.since)}.
          {github.ends_at ? ` The App is no longer installed: this proof ends ${dateOf(github.ends_at)} unless it is installed again.` : ""}
        </p>
      ) : (
        <p class="lede">No GitHub organisation is proven yet.</p>
      )}
      {owner && !github ? (
        <form class="form" id="prove-github">
          <label><span>GitHub organisation</span><input type="text" name="org" required placeholder="acme" autocomplete="off" spellcheck={false} /></label>
          <label>
            <span>Prove it by</span>
            <select name="method">
              <option value="app">The GitHub App installed on the organisation</option>
              <option value="admin">My own sign-in as an owner of the organisation</option>
            </select>
          </label>
          <div><button class="btn" type="submit">Prove a GitHub organisation</button></div>
        </form>
      ) : null}

      <h3 class="mt2">Verified Publisher</h3>
      <p class="lede"><Price amount={PRICES.verifiedPublisher.amount} unit={PRICES.verifiedPublisher.unit} /></p>
      {application.state === "approved" ? (
        <p class="lede">Verified Publisher{application.basis ? `, resting on the ${application.basis === "domain" ? "domain" : "GitHub organisation"} proof` : ""}. Approved {dateOf(application.decided_at)}.</p>
      ) : application.state === "pending" ? (
        <p class="lede" role="status">Verification pending. Applied {dateOf(application.applied_at)}; an admin will review it.</p>
      ) : (
        <>
          {application.state === "rejected" ? (
            <p class="lede">Not approved on {dateOf(application.decided_at)}{application.denial_reason ? `: ${application.denial_reason}` : "."}
              {!renewable && application.renewable_at ? ` You can apply again from ${dateOf(application.renewable_at)}.` : ""}</p>
          ) : application.state === "revoked" ? (
            <p class="lede">The status was revoked{application.denial_reason ? `: ${application.denial_reason}` : "."}</p>
          ) : (
            <p class="lede">Not applied.</p>
          )}
          {missing.length > 0 ? <p class="small muted">Before applying: {missing.join("; and ")}.</p> : null}
          {owner ? (
            <p class="mt2"><button class="btn" type="button" data-do="apply" disabled={missing.length > 0 || !renewable}>Apply for Verified Publisher</button></p>
          ) : null}
        </>
      )}
    </section>
  );
}

function People(props: { org: OrgSettings }) {
  const { org } = props;
  const owner = org.role === "owner";
  return (
    <section id="people">
      <h2>Owners and maintainers</h2>
      <p class="lede">Owners manage the organisation. Maintainers publish and edit listings.</p>
      <ul class="list">
        {org.people.map((p) => (
          <li>
            <span class="grow">@{p.handle} <span class="when">{p.role} · since {dateOf(p.since)}</span></span>
            {owner ? (
              <>
                <button class="btn quiet" type="button" data-do="set-role" data-handle={p.handle} data-role={p.role === "owner" ? "maintainer" : "owner"}>
                  {p.role === "owner" ? "Make maintainer" : "Make owner"}
                </button>
                <button class="btn quiet danger" type="button" data-do="remove-person" data-handle={p.handle}>Remove</button>
              </>
            ) : null}
          </li>
        ))}
        {org.invitations.map((i) => (
          <li>
            <span class="grow">{i.handle ? `@${i.handle}` : i.email} <span class="when">invited as {i.role} · {dateOf(i.invited_at)}</span></span>
            {owner ? <button class="btn quiet danger" type="button" data-do="remove-invitation" data-id={i.id}>Withdraw</button> : null}
          </li>
        ))}
      </ul>
      {owner ? (
        <form class="form" id="invite">
          <label><span>Handle or email address</span><input type="text" name="who" required placeholder="@handle or name@example.com" autocomplete="off" spellcheck={false} /></label>
          <label>
            <span>Role</span>
            <select name="role"><option value="maintainer">Maintainer</option><option value="owner">Owner</option></select>
          </label>
          <div><button class="btn" type="submit">Invite</button></div>
        </form>
      ) : null}
    </section>
  );
}

function Security(props: { org: OrgSettings }) {
  const { org } = props;
  return (
    <section id="security">
      <h2>Security</h2>
      <p class="lede">Everyone acting for the organisation must have what you require enrolled, or they cannot act for it.</p>
      {org.role === "owner" ? (
        <form class="form" id="mfa-policy">
          <label>
            <span>Sign-in requirement</span>
            <select name="policy">
              {MFA_POLICIES.map((p) => <option value={p} selected={p === org.mfa}>{POLICY_LABEL[p]}</option>)}
            </select>
          </label>
          <div><button class="btn" type="submit">Save</button></div>
        </form>
      ) : (
        <p class="lede">Current requirement: {POLICY_LABEL[org.mfa]}.</p>
      )}
    </section>
  );
}

function Danger(props: { org: OrgSettings }) {
  const { org } = props;
  if (org.role !== "owner") {
    return (
      <section id="danger">
        <h2>Transfer and delete</h2>
        <p class="lede">Only an owner can transfer a pack or delete the organisation.</p>
      </section>
    );
  }
  return (
    <section id="danger">
      <h2>Transfer and delete</h2>
      <h3>Transfer a pack</h3>
      {org.packs.length === 0 ? (
        <p class="lede">The organisation has no packs.</p>
      ) : (
        <form class="form" id="transfer">
          <label>
            <span>Pack</span>
            <select name="pack">{org.packs.map((p) => <option value={p}>{p}</option>)}</select>
          </label>
          <label><span>Offer it to the scope</span><input type="text" name="to" required placeholder="@other" pattern="@?[a-z0-9\-]+" autocomplete="off" spellcheck={false} /></label>
          <p class="hint small muted">Nothing moves until an owner of that scope accepts.</p>
          <div><button class="btn" type="submit">Offer the pack</button></div>
        </form>
      )}
      <h3 class="mt2">Delete the organisation</h3>
      <p class="lede">The name is retired for good and can never be used again.</p>
      {org.packs.length > 0 ? (
        <p class="small muted">It owns {plural(org.packs.length, "pack")}. Transfer {org.packs.length === 1 ? "it" : "them"} first: an organisation with packs cannot be deleted.</p>
      ) : null}
      <p class="mt2"><button class="btn danger" type="button" data-do="delete-org" disabled={org.packs.length > 0}>Delete @{org.scope.name}</button></p>
    </section>
  );
}

routes.get("/orgs/:org/settings", async (c) => {
  const who = await signedIn(c);
  if (who instanceof Response) return who;
  const name = c.req.param("org");
  const result = await loadOrgSettings(c, name, who.userId);
  c.header("cache-control", "private, no-store");
  const nonce = c.get("cspNonce");
  if (result.kind === "not_found") return notFoundPage(c);
  if (result.kind === "mfa_required") {
    return renderPage(c, {
      title: `@${result.scope} · Claudinite Packs`,
      children: (
        <div class="acct">
          <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS }} />
          <h1>@{result.scope}</h1>
          <p class="lede">This organisation requires a passkey from everyone acting for it. <a href="/account/security?step=enrol">Add a passkey</a> to continue.</p>
        </div>
      ),
    });
  }
  const { org } = result;
  return renderPage(c, {
    title: `@${org.scope.name} settings · Claudinite Packs`,
    children: (
      <div class="acct">
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: ACCOUNT_CSS + SETTINGS_CSS }} />
        <div id="ps" data-csrf={who.csrf} data-user={who.userId} data-org={org.scope.name} />
        <h1>@{org.scope.name}</h1>
        <nav class="jump small" aria-label="Settings">
          <a href="#general">General</a><a href="#verification">Verification</a><a href="#people">People</a><a href="#security">Security</a><a href="#danger">Danger</a>
        </nav>
        <section id="general">
          <h2>General</h2>
          <ul class="list">
            <li><span class="grow">Name and handle</span><span>@{org.scope.name}</span></li>
            <li><span class="grow">Your role</span><span>{org.role}</span></li>
            <li><span class="grow">Public page</span><a href={`/@${org.scope.name}`}>/@{org.scope.name}</a></li>
          </ul>
        </section>
        <Verification org={org} />
        <People org={org} />
        <Security org={org} />
        <Danger org={org} />
        <p class="status" id="ps-status" role="status" />
        <ActionDialog />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLIENT_LIB }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: ORG_CLIENT }} />
      </div>
    ),
  });
});
