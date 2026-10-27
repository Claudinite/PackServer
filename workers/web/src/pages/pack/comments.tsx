/** Opens a section's thread on first use and builds it from the JSON API; text only ever goes in as textContent. */
export const COMMENTS_SCRIPT = `
(function () {
  var api = null;
  function session() {
    if (api === null) api = fetch("/api/auth/session").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    return api;
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function call(box, method, path, body) {
    return session().then(function (s) {
      return fetch("/api/packs/" + box.dataset.pack + path, {
        method: method,
        headers: { "x-csrf-token": s ? s.csrf : "", "content-type": "application/json", "idempotency-key": crypto.randomUUID().replaceAll("-", "") },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    });
  }
  function vote(box, c, value) {
    var again = c.mine === value;
    call(box, again ? "DELETE" : "PUT", "/comments/" + c.id + "/vote", again ? undefined : { value: value }).then(function (r) { if (r.ok) load(box); else box.querySelector(".cm-status").textContent = "The vote was refused."; });
  }
  function one(box, c, signedIn) {
    var li = el("li", "cm-item");
    li.appendChild(el("p", "cm-meta", (c.author || "Someone") + " on " + c.version + (c.held ? " (only you can see this comment)" : "")));
    li.appendChild(el("p", "cm-body", c.body));
    var bar = el("p", "cm-votes");
    bar.appendChild(el("span", "", "+" + c.up + " / -" + c.down));
    if (signedIn) {
      [[1, "Up"], [-1, "Down"]].forEach(function (v) {
        var b = el("button", "", v[1]); b.type = "button"; b.setAttribute("aria-pressed", String(c.mine === v[0]));
        b.addEventListener("click", function () { vote(box, c, v[0]); });
        bar.appendChild(b);
      });
    }
    li.appendChild(bar);
    return li;
  }
  function load(box) {
    Promise.all([session(), fetch("/api/packs/" + box.dataset.pack + "/comments?section=" + encodeURIComponent(box.dataset.thread))]).then(function (got) {
      if (!got[1].ok) { box.querySelector(".cm-status").textContent = "Comments could not be loaded."; return; }
      return got[1].json().then(function (body) {
        var list = box.querySelector(".cm-list"), hiddenBox = box.querySelector(".cm-hidden"), hiddenList = hiddenBox.querySelector("ul");
        list.replaceChildren(); hiddenList.replaceChildren();
        var signedIn = got[0] !== null;
        body.comments.forEach(function (c) { (c.hidden ? hiddenList : list).appendChild(one(box, c, signedIn)); });
        hiddenBox.hidden = hiddenList.children.length === 0;
        box.querySelector(".cm-empty").hidden = body.comments.length > 0;
        box.querySelector(".cm-form").hidden = !signedIn;
        box.querySelector(".cm-signin").hidden = signedIn;
        box.querySelector(".cm-status").textContent = "";
      });
    });
  }
  document.querySelectorAll("details.cm").forEach(function (box) {
    var loaded = false;
    box.addEventListener("toggle", function () { if (box.open && !loaded) { loaded = true; load(box); } });
    box.querySelector(".cm-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var form = event.target, status = box.querySelector(".cm-status");
      status.textContent = "Sending...";
      call(box, "POST", "/comments", { section: box.dataset.thread, version: box.dataset.version, body: form.body.value }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) { status.textContent = body.message || "The comment was refused."; return; }
          form.body.value = ""; load(box);
        });
      }).catch(function () { status.textContent = "The comment could not be sent."; });
    });
  });
})();
`;

/**
 * A section's thread, collapsed until opened. The page can be cached for everyone, so the thread and the form arrive
 * from the API after the visitor opens it.
 */
export function SectionComments(props: { pack: string; version: string; section: string; count: number }) {
  return (
    <details class="cm" data-pack={props.pack} data-version={props.version} data-thread={props.section}>
      <summary>{props.count === 0 ? "Comments" : `Comments (${props.count})`}</summary>
      <p class="cm-status muted" role="status"></p>
      <p class="cm-empty muted">No comments on this section yet.</p>
      <ul class="cm-list" />
      <details class="cm-hidden" hidden>
        <summary>Hidden: net-negative votes</summary>
        <ul />
      </details>
      <form class="cm-form" hidden>
        <label>Comment on this section <textarea name="body" required maxlength={2000} /></label>
        <button type="submit">Post comment</button>
      </form>
      <p class="cm-signin" hidden><a href={`/signin?next=${encodeURIComponent(`/packs/${props.pack}/contents`)}`}>Sign in</a> to comment and vote.</p>
    </details>
  );
}
