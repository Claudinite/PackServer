#!/usr/bin/env node
// Registers the PackServer GitHub App from a manifest and stores its credentials in Secrets Store.
// Flow: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { ConfigError, createSecretsStore, resolveCloudflareConfig, secretPrefix } from "./lib/secrets-store.mjs";

const ORG = "Claudinite";
const execFileP = promisify(execFile);

const USAGE = `Usage: node infra/github-app-manifest.mjs --env <staging|production> [--port N] [--dry-run]

Serves a one-page form on http://127.0.0.1:<port> that submits the App manifest to GitHub, opens
your browser, waits for the redirect back to /callback (state is checked), exchanges the code
(POST /app-manifests/{code}/conversions, authenticated with \`gh auth token\`) and stores
GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_WEBHOOK_SECRET and
GITHUB_APP_PRIVATE_KEY in Secrets Store (staging names carry the prefix STAGING_). Then prints
the install URL. The credentials are never printed or written to disk.

Run as a ${ORG} organisation owner (\`gh auth login\`). Requires CF_BOOTSTRAP_TOKEN in the
environment. CLOUDFLARE_ACCOUNT_ID is looked up when the token sees exactly one account;
CLOUDFLARE_SECRETS_STORE_ID picks a store when there are several. GitHub allows one hour for
form, callback and conversion.

GitHub shows the credentials once, so before the browser opens the script proves it can write
to Secrets Store (a throwaway secret, created and deleted). After the exchange, store writes
retry with backoff; if some still fail the values stay in memory and you are asked to press
Enter to retry the remaining names. Nothing is written to disk.

  --port     fixed local port (default: a free one)
  --dry-run  print the manifest and the secret names; no server, no network
  --help     this text
`;

export const SECRET_FIELDS = [
  ["GITHUB_APP_ID", (c) => String(c.id)],
  ["GITHUB_APP_CLIENT_ID", (c) => c.client_id],
  ["GITHUB_APP_CLIENT_SECRET", (c) => c.client_secret],
  ["GITHUB_APP_WEBHOOK_SECRET", (c) => c.webhook_secret],
  ["GITHUB_APP_PRIVATE_KEY", (c) => c.pem],
];

export function buildManifest(env, port) {
  const staging = env === "staging";
  const origin = staging ? "https://registry-staging.claudinite.com" : "https://registry.claudinite.com";
  return {
    name: staging ? "Claudinite Packs (staging)" : "Claudinite Packs",
    url: origin,
    hook_attributes: { url: `${origin}/hooks/github`, active: true },
    redirect_url: `http://127.0.0.1:${port}/callback`,
    callback_urls: [`${origin}/api/auth/github/callback`],
    setup_url: `${origin}/github/installed`,
    public: true,
    request_oauth_on_install: true,
    default_events: ["installation", "installation_repositories", "issues"],
    default_permissions: { metadata: "read", members: "read", issues: "read", contents: "read", email_addresses: "read" },
  };
}

export const formAction = (state) => `https://github.com/organizations/${ORG}/settings/apps/new?state=${state}`;

const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function renderForm(manifest, state) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Register GitHub App</title></head>
<body>
<p>Sending the manifest to GitHub. If nothing happens, press the button.</p>
<form id="f" method="post" action="${escapeAttr(formAction(state))}">
<input type="hidden" name="manifest" value="${escapeAttr(JSON.stringify(manifest))}">
<button type="submit">Create the GitHub App</button>
</form>
<script>document.getElementById("f").submit();</script>
</body></html>`;
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function ghToken() {
  const { stdout } = await execFileP("gh", ["auth", "token"]);
  const t = stdout.trim();
  if (!t) throw new Error("`gh auth token` printed nothing; run `gh auth login` as an organisation owner");
  return t;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}

const defaultPrompt = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

// Values stay in memory only. Returns the names that could not be stored (empty on success).
async function storeAll({ store, items, comment, out, err, prompt, appUrl, appId, clientId }) {
  let pending = items;
  for (;;) {
    const failed = [];
    for (const item of pending) {
      try {
        await store.create(item.name, item.value, comment);
        out(`created ${item.name}`);
      } catch (e) {
        err(`could not store ${item.name}: ${e.message}`);
        failed.push(item);
      }
    }
    if (!failed.length) return [];
    const answer = (await prompt(`${failed.length} secret(s) not stored (${failed.map((f) => f.name).join(", ")}). Press Enter to retry, or type abort: `)).trim().toLowerCase();
    if (answer === "abort") {
      err(
        `GitHub will not show these again, but they can be regenerated: open ${appUrl} and generate a new client secret, private key and webhook secret, then store ${failed.map((f) => f.name).join(", ")} yourself. ` +
          `The App ID (${appId}) and client ID (${clientId}) are public and were not lost.`,
      );
      return failed.map((f) => f.name);
    }
    pending = failed;
  }
}

async function convert(fetchImpl, code, token) {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`manifest conversion failed: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(body.slug)) {
    throw new Error("conversion response has no usable App slug");
  }
  for (const [name, pick] of SECRET_FIELDS) {
    if (!pick(body)) throw new Error(`conversion response is missing the field behind ${name}`);
  }
  return body;
}

// Resolves with the callback's code once /callback arrives with the right state.
function waitForCallback({ state, listen, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Only the exact loopback origin may read the form or deliver the code; this stops a
      // DNS-rebinding page from reading the state.
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
        res.writeHead(421, { "content-type": "text/plain" });
        res.end("wrong host");
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/" && req.method === "GET") {
        const address = server.address();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(renderForm(buildManifest(listen.env, address.port), state));
      } else if (url.pathname === "/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const got = url.searchParams.get("state") ?? "";
        if (!code || !safeEqual(got, state)) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("state mismatch or missing code; start again");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Received. You can close this tab and return to the terminal.");
        clearTimeout(timer);
        server.close();
        resolve(code);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("timed out after one hour waiting for GitHub's redirect"));
    }, timeoutMs);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => listen.ready(server.address().port));
  });
}

export async function main(argv, envVars, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { env: { type: "string" }, port: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } },
      strict: true,
    }));
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (!values.env) {
    err(`--env is required\n\n${USAGE}`);
    return 2;
  }
  let prefix;
  try {
    prefix = secretPrefix(values.env);
  } catch (e) {
    err(e.message);
    return 2;
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    err(`--port must be an integer between 0 and 65535, got "${values.port}"`);
    return 2;
  }

  if (values["dry-run"]) {
    out(`[dry-run] env=${values.env}: would POST this manifest to ${formAction("<state>")}`);
    out(JSON.stringify(buildManifest(values.env, port || "<port>"), null, 2));
    out(`[dry-run] then convert the code and create: ${SECRET_FIELDS.map(([n]) => prefix + n).join(", ")}; no network calls made.`);
    return 0;
  }

  try {
    const fetchImpl = deps.fetch ?? fetch;
    const store = createSecretsStore({ fetch: fetchImpl, sleep: deps.sleep, ...(await resolveCloudflareConfig(envVars, fetchImpl)) });
    const names = SECRET_FIELDS.map(([n]) => prefix + n);
    const existing = await store.listNames();
    const present = names.filter((n) => existing.has(n));
    if (present.length) {
      err(`refusing to run: already in Secrets Store: ${present.join(", ")}\nA second App registration would orphan them; remove them deliberately first.`);
      return 1;
    }
    await store.probeWrite(`PACKSERVER_WRITE_PROBE_${randomBytes(4).toString("hex")}`);
    out("Secrets Store write access confirmed.");
    const token = await (deps.ghToken ?? ghToken)();
    const state = (deps.state ?? (() => randomBytes(16).toString("hex")))();
    const code = await waitForCallback({
      state,
      port,
      timeoutMs: deps.timeoutMs ?? 60 * 60 * 1000,
      listen: {
        env: values.env,
        ready: (p) => {
          const url = `http://127.0.0.1:${p}/`;
          out(`Open ${url} if the browser does not open by itself, then click "Create GitHub App" on GitHub.`);
          (deps.openBrowser ?? openBrowser)(url);
        },
      },
    });
    const converted = await convert(deps.fetch ?? fetch, code, token);
    const items = SECRET_FIELDS.map(([name, pick]) => ({ name: prefix + name, value: pick(converted) }));
    const left = await storeAll({
      store,
      items,
      comment: `GitHub App ${converted.slug} (${values.env})`,
      out,
      err,
      prompt: deps.prompt ?? defaultPrompt,
      appUrl: converted.html_url ?? `https://github.com/organizations/${ORG}/settings/apps/${converted.slug}`,
      appId: converted.id,
      clientId: converted.client_id,
    });
    out(`Install the App: https://github.com/apps/${converted.slug}/installations/new`);
    return left.length ? 1 : 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    err(`failed: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
