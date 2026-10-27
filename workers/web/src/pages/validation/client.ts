/** Keeps a run that has not finished current, and sends the one appeal. */
export const VALIDATION_CLIENT = String.raw`
(function () {
  var page = document.getElementById("run");
  if (!page) return;
  var id = page.getAttribute("data-run");

  if (page.getAttribute("data-status") !== "finished") {
    var steps = document.getElementById("steps");
    var line = document.getElementById("verdict");
    var started = Date.now();
    var timer;
    var tick = function () {
      if (document.hidden) return;
      if (Date.now() - started > 15 * 60 * 1000) { clearInterval(timer); return; }
      fetch("/validation/" + encodeURIComponent(id) + "/state", { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(function (res) { if (res.status === 404) clearInterval(timer); return res.ok ? res.json() : null; })
        .then(function (state) {
          if (!state) return;
          if (state.status === "finished") { location.reload(); return; }
          line.textContent = state.status === "queued" ? "Waiting to start." : "Validating. This page updates by itself.";
          steps.textContent = "";
          state.milestones.forEach(function (m) {
            var li = document.createElement("li");
            li.textContent = m.step + " · " + m.outcome;
            steps.appendChild(li);
          });
        })
        .catch(function () {});
    };
    timer = setInterval(tick, 2000);
  }

  var form = document.getElementById("appeal");
  if (form) {
    var say = document.getElementById("ps-status");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      say.textContent = "";
      window.PS.api("POST", "/api/publish/runs/" + encodeURIComponent(id) + "/appeal", { note: form.elements.note.value.trim() })
        .then(function () { location.reload(); })
        .catch(function (err) { say.textContent = err.message; });
    });
  }
})();
`;

/** Confirms an approval with a passkey, for any page that renders the approval sheet. */
export const APPROVE_CLIENT = String.raw`
(function () {
  var PS = window.PS;
  var status = document.getElementById("ps-status");
  document.addEventListener("click", function (e) {
    var button = e.target.closest ? e.target.closest("[data-approve]") : null;
    if (!button) return;
    var id = button.getAttribute("data-approve");
    status.textContent = "";
    PS.sensitive({
      title: "Approve " + button.getAttribute("data-pack") + " " + button.getAttribute("data-version"),
      detail: "It is published as soon as you confirm, and every owner is told by email.",
      action: "publish.approve", target: id,
      run: function (assertion) {
        return PS.api("POST", "/api/publish/runs/" + encodeURIComponent(id) + "/approve", {}, assertion ? { "x-assertion": assertion } : {});
      }
    }).then(function (done) { if (done) location.reload(); }).catch(function (err) { if (!PS.declined(err)) status.textContent = err.message; });
  });
})();
`;
