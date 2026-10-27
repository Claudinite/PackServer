import type { OpsState } from "./state";

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The `data-act` of a button is the JSON the page posts, so the server renders every tap and the script only sends it. */
const act = (label: string, body: Record<string, unknown>, o: { ask?: string; danger?: boolean } = {}): string =>
  `<button type="button" data-act="${escape(JSON.stringify(body))}"${o.ask ? ` data-ask="${escape(o.ask)}"` : ""}${o.danger ? ' class="danger"' : ""}>${escape(label)}</button>`;

const field = (name: string, label: string): string => `<label>${escape(label)}<input name="${escape(name)}" autocomplete="off"></label>`;

/** A form whose fields are merged into the action body; the first button's `data-act` names the method. */
const form = (title: string, method: string, fields: Array<[string, string]>, button: string): string =>
  `<form data-method="${escape(method)}"><h3>${escape(title)}</h3>${fields.map(([n, l]) => field(n, l)).join("")}<button type="submit">${escape(button)}</button></form>`;

const row = (label: string, state: string, taps: string): string => `<li><span class="what">${escape(label)}</span><span class="state">${escape(state)}</span>${taps}</li>`;

/** The shell's policy lets an inline block run only under the response's nonce, so the page carries its own style and script. */
export function opsPage(state: OpsState, nonce: string): string {
  const blocks = state.blocked_sources.length
    ? state.blocked_sources
        .map((b) => `<li><span class="what">${escape(b.source)}</span><span class="state">${escape(b.reason)}</span>${act("Unblock", { method: "unblock_source", source: b.source, reason: "lifted from the ops page" }, { ask: `Unblock ${b.source}?` })}</li>`)
        .join("")
    : '<li class="none">No source is blocked.</li>';
  const actions = state.recent_actions.length
    ? state.recent_actions.map((a) => `<li><span class="what">${escape(a.verb)}</span><span class="state">${escape(a.target ?? "")}</span><span class="when">${escape(a.at.slice(0, 19))} ${escape(a.actor)}</span></li>`).join("")
    : '<li class="none">Nothing yet.</li>';
  const flags = state.flags.map((f) => `<li><span class="what">${escape(f.key)}${f.security ? " (security)" : ""}</span><span class="state">${escape(JSON.stringify(f.value))}${f.source === "stored" ? "" : ` (${escape(f.source)})`}</span></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ops</title><style nonce="${escape(nonce)}">${OPS_STYLE}</style></head>
<body><main>
<h1>Ops</h1>
<p class="meta">Release ${escape(state.release)}. Every tap is an audited admin action.</p>
<p id="result" role="status" aria-live="polite"></p>
<section><h2>Taps</h2><ul class="taps">
${row("Roll back", state.rollback_url ? "run the workflow on GitHub" : "not available here", state.rollback_url ? `<a href="${escape(state.rollback_url)}" rel="noreferrer">Open the rollback workflow</a>` : "")}
${row("New packs", state.kill_switch ? "paused" : "open", state.kill_switch ? act("Resume new packs", { method: "disable_new_pack_kill_switch", reason: "resumed from the ops page" }, { ask: "Let new packs publish again?" }) : act("Pause new packs", { method: "enable_new_pack_kill_switch", reason: "paused from the ops page" }, { ask: "Stop new packs from publishing?", danger: true }))}
${row("Index regeneration", state.index_frozen ? "frozen" : "running", state.index_frozen ? act("Unfreeze", { method: "unfreeze_index_regeneration", reason: "unfrozen from the ops page" }, { ask: "Let the index regenerate again?" }) : act("Freeze", { method: "freeze_index_regeneration", reason: "frozen from the ops page" }, { ask: "Freeze index regeneration?", danger: true }) + act("Regenerate now", { method: "regenerate_index" }, { ask: "Regenerate every scope index?" }))}
${row("Telemetry", state.telemetry_mode, state.telemetry_mode === "normal" ? act("Economy", { method: "set_telemetry_mode", mode: "economy" }) : act("Normal", { method: "set_telemetry_mode", mode: "normal" }))}
</ul></section>
<section><h2>Name the target</h2>
${form("Quarantine a version", "quarantine_version", [["pack", "Pack (@scope/name)"], ["version", "Version"], ["reason", "Reason"]], "Quarantine")}
${form("Lift a quarantine", "unquarantine_version", [["pack", "Pack (@scope/name)"], ["version", "Version"], ["reason", "Reason"]], "Lift")}
${form("Block a source", "block_source", [["source", "Source"], ["reason", "Reason"]], "Block")}
${form("Acknowledge a page", "acknowledge_page", [["page", "Page"]], "Acknowledge")}
</section>
<section><h2>Blocked sources</h2><ul>${blocks}</ul></section>
<section><h2>Flags</h2><ul>${flags}</ul></section>
<section><h2>Recent actions</h2><ul>${actions}</ul></section>
</main><script nonce="${escape(nonce)}">${OPS_SCRIPT}</script></body></html>`;
}

const OPS_SCRIPT = `const result = document.getElementById("result");
const say = (text) => { result.textContent = text; };
async function send(body) {
  say("Working...");
  try {
    const response = await fetch("/admin/ops/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = await response.json();
    if (answer.ok) { say("Done (" + answer.audit_id + ")"); setTimeout(() => location.reload(), 600); }
    else say("Refused: " + (answer.refusal && answer.refusal.message || "no reason"));
  } catch (error) { say("The request failed."); }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  if (button.dataset.ask && !confirm(button.dataset.ask)) return;
  send(JSON.parse(button.dataset.act));
});
document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-method]");
  if (!form) return;
  event.preventDefault();
  const body = { method: form.dataset.method };
  for (const input of form.querySelectorAll("input")) body[input.name] = input.value;
  send(body);
});
`;

const OPS_STYLE = `body{font:16px/1.4 system-ui,sans-serif;margin:0;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}
main{max-width:40rem;margin:0 auto;padding:1rem 16px 3rem}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}h3{font-size:1rem;margin:.5rem 0}
ul{list-style:none;padding:0}li{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.5rem 0;border-bottom:1px solid #8884}
.what{font-weight:600;flex:1 1 10rem}.state,.when,.meta{opacity:.75}.none{opacity:.6}
button{font:inherit;min-height:44px;padding:0 1rem;border-radius:.5rem;border:1px solid #888;background:transparent;color:inherit}
button.danger{border-color:#c33;color:#c33}
form{display:flex;flex-direction:column;gap:.5rem;padding:.75rem 0;border-bottom:1px solid #8884}
label{display:flex;flex-direction:column;font-size:.9rem;gap:.2rem}input{font:inherit;min-height:44px;padding:0 .5rem}
`;
