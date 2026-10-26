/** Wires the access page's forms and buttons to the grant and visibility routes; each goes through `PS.sensitive`. */
export const ACCESS_CLIENT = String.raw`
(function () {
  var PS = window.PS;
  var host = document.getElementById("ps");
  var pack = host.getAttribute("data-pack");
  var base = "/api/packs/" + pack;
  var status = document.getElementById("ps-status");
  var reload = function () { location.reload(); };
  var withAssertion = function (assertion) { return assertion ? { "x-assertion": assertion } : {}; };

  function say(message) { status.textContent = message; }
  function failed(e) { say(e && e.message ? e.message : "That did not work. Try again."); }

  var addForm = document.getElementById("add-grant");
  if (addForm) addForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var account = addForm.elements.account_id.value.trim();
    var only = addForm.elements.private_repos_only.checked;
    PS.sensitive({
      title: "Add a GitHub account", detail: "Account " + account + " will be able to read this pack.", action: "grant.add", target: pack.slice(1) + ":" + account + ":" + (only ? "private" : "any"),
      run: function (assertion) { return PS.api("POST", base + "/grants", { account_id: account, private_repos_only: only }, withAssertion(assertion)); }
    }).then(function (done) { if (done) reload(); }, failed);
  });

  var publicForm = document.getElementById("make-public");
  if (publicForm) publicForm.addEventListener("submit", function (event) {
    event.preventDefault();
    PS.sensitive({
      title: "Make this pack public", detail: "Every version becomes public and this cannot be undone.", action: "pack.visibility", target: pack.slice(1),
      run: function (assertion) { return PS.api("POST", base + "/visibility", { visibility: "public", confirm: true }, withAssertion(assertion)); }
    }).then(function (done) { if (done) reload(); }, failed);
  });

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-do]") : null;
    if (!button) return;
    var what = button.getAttribute("data-do");
    if (what === "remove-grant") {
      var account = button.getAttribute("data-account");
      PS.sensitive({
        title: "Remove this account", detail: "Account " + account + " stops being able to read this pack at its next read.", action: "grant.remove", target: pack.slice(1) + ":" + account,
        run: function (assertion) { return PS.api("DELETE", base + "/grants/" + encodeURIComponent(account), undefined, withAssertion(assertion)); }
      }).then(function (done) { if (done) reload(); }, failed);
    } else if (what === "make-private") {
      PS.sensitive({
        title: "Make this pack private", detail: "Versions published from now on are private. Versions already public stay public.", action: "pack.visibility", target: pack.slice(1),
        run: function (assertion) { return PS.api("POST", base + "/visibility", { visibility: "private" }, withAssertion(assertion)); }
      }).then(function (done) { if (done) reload(); }, failed);
    }
  });
})();
`;
