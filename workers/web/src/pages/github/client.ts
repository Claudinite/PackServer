/** Wires the GitHub page's registration forms and switches; every change goes through `PS.sensitive` except turning trusted-only on. */
export const GITHUB_CLIENT = String.raw`
(function () {
  var PS = window.PS;
  var status = document.getElementById("ps-status");
  var reload = function () { location.reload(); };
  var withAssertion = function (assertion) { return assertion ? { "x-assertion": assertion } : {}; };
  var enc = encodeURIComponent;
  var ACTION = "trusted-publisher.change";

  function say(message) { status.textContent = message; }
  function lines(text) { return text.split(/[\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean); }

  function bodyOf(f) {
    var body = {
      repository: f.elements.repository.value.trim(),
      repository_id: f.elements.repository_id.value.trim(),
      repository_owner_id: f.elements.repository_owner_id.value.trim(),
      workflow: f.elements.workflow.value.trim(),
      path: f.elements.path.value.trim(),
      environment: f.elements.environment.value.trim() || null
    };
    var refs = lines(f.elements.refs.value);
    if (refs.length) body.refs = refs;
    var events = Array.prototype.filter.call(f.querySelectorAll('input[name="events"]'), function (box) { return box.checked; }).map(function (box) { return box.value; });
    body.events = events;
    return body;
  }

  function submit(form) {
    var scope = form.getAttribute("data-scope");
    var pack = form.getAttribute("data-pack") || form.elements.pack.value.trim();
    var id = form.getAttribute("data-id");
    var body = bodyOf(form);
    var url = "/api/trusted-publishers/" + enc(scope) + "/" + enc(pack) + (id ? "/" + enc(id) : "");
    var full = "@" + scope + "/" + pack;
    return PS.sensitive({
      title: id ? "Change the trusted publisher" : "Add a trusted publisher",
      detail: full + " and every owner of it are told by email.",
      action: ACTION, target: scope + "/" + pack,
      run: function (assertion) { return PS.api(id ? "PUT" : "POST", url, body, withAssertion(assertion)); }
    }).then(function (done) { if (done) reload(); });
  }

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form.classList || !form.classList.contains("reg")) return;
    e.preventDefault();
    say("");
    submit(form).catch(function (err) { if (!PS.declined(err)) say(err.message); });
  });

  var actions = {
    "trusted-only-on": function (button) {
      var url = "/api/trusted-publishers/" + enc(button.getAttribute("data-scope")) + "/" + enc(button.getAttribute("data-pack")) + "/only";
      return PS.api("PUT", url, {}).then(reload);
    },
    "trusted-only-off": function (button) {
      var scope = button.getAttribute("data-scope");
      var pack = button.getAttribute("data-pack");
      var url = "/api/trusted-publishers/" + enc(scope) + "/" + enc(pack) + "/only";
      return PS.sensitive({
        title: "Allow web uploads again", detail: "@" + scope + "/" + pack + ": anyone who can publish it may upload by hand.", action: ACTION, target: scope + "/" + pack,
        run: function (assertion) { return PS.api("DELETE", url, undefined, withAssertion(assertion)); }
      }).then(function (done) { if (done) reload(); });
    },
    "copy": function (button) {
      var text = document.getElementById(button.getAttribute("data-target")).textContent;
      if (!navigator.clipboard) return Promise.reject(new Error("Select the text and copy it."));
      return navigator.clipboard.writeText(text).then(function () { button.textContent = "Copied"; });
    }
  };

  document.addEventListener("click", function (e) {
    var button = e.target.closest ? e.target.closest("[data-do]") : null;
    if (!button) return;
    var act = actions[button.getAttribute("data-do")];
    if (!act) return;
    e.preventDefault();
    say("");
    act(button).catch(function (err) { if (!PS.declined(err)) say(err.message); });
  });
})();
`;
