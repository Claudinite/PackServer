/** Keeps a run that has not finished current, and sends the one appeal. */
export const VALIDATION_CLIENT = String.raw`
(function () {
  var page = document.getElementById("run");
  if (!page) return;
  var id = page.getAttribute("data-run");

  if (page.getAttribute("data-status") !== "finished") {
    var steps = document.getElementById("steps");
    var line = document.getElementById("verdict");
    var tick = function () {
      fetch("/validation/" + encodeURIComponent(id) + "/state", { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(function (res) { return res.ok ? res.json() : null; })
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
    setInterval(tick, 2000);
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
