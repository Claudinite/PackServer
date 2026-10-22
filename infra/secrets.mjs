#!/usr/bin/env node
// Key ceremony: generate the registry signing keys and HMAC keys in memory and upload them to
// Secrets Store. Only public halves are printed; nothing is written to disk.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ConfigError, createSecretsStore, resolveCloudflareConfig, secretPrefix } from "./lib/secrets-store.mjs";

export const HMAC_SECRETS = [
  ["SELFTEST_HMAC_KEY", "self-test request signing (release.md)"],
  ["IP_HASH_MASTER_KEY", "ip_hash 90-day master"],
  ["PRINCIPAL_HASH_KEY", "principal_hash stable key"],
  ["ADMIN_FLAG_HMAC_KEY", "admin security-flag HMAC"],
];

const USAGE = `Usage: node infra/secrets.mjs --env <staging|production> [--kid YYYY-MM] [--dry-run] [--skip-existing]

Generates in memory and uploads to Cloudflare Secrets Store:
  REGISTRY_SIGNING_KEY_<YYYY>_<MM>   active Ed25519 key (kid = YYYY-MM, default: this month)
  REGISTRY_SIGNING_KEY_<YYYY>_<MM+1> standby Ed25519 key, bound to no Worker
  ${HMAC_SECRETS.map(([n]) => n).join(", ")}
Staging names carry the prefix STAGING_. Prints only the two public signing halves.

Requires CF_BOOTSTRAP_TOKEN in the environment. CLOUDFLARE_ACCOUNT_ID is looked up when the token
sees exactly one account; CLOUDFLARE_SECRETS_STORE_ID picks a store when there are several.

  --kid            key id of the active key (default: current UTC month)
  --dry-run        print the secret names that would be created; no network, no keys generated
  --skip-existing  upload only names not already present; without it, any existing name aborts
                   the run before anything is written
  --help           this text
`;

export function kidFor(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextKid(kid) {
  const [y, m] = kid.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export const signingSecretName = (prefix, kid) => `${prefix}REGISTRY_SIGNING_KEY_${kid.replace("-", "_")}`;

export function generateSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    // PKCS#8 DER (importable with WebCrypto in a Worker); the public half is the raw 32 bytes.
    privateValue: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicRaw: publicKey.export({ format: "jwk" }).x,
  };
}

const randomKey = () => randomBytes(32).toString("base64url");

export function planSecrets(env, activeKid) {
  const prefix = secretPrefix(env);
  const standbyKid = nextKid(activeKid);
  return {
    activeKid,
    standbyKid,
    names: [
      signingSecretName(prefix, activeKid),
      signingSecretName(prefix, standbyKid),
      ...HMAC_SECRETS.map(([n]) => `${prefix}${n}`),
    ],
    prefix,
  };
}

export async function main(argv, envVars, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const now = deps.now ?? (() => new Date());
  const keygen = deps.generateSigningKey ?? generateSigningKey;
  const newKey = deps.randomKey ?? randomKey;
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        env: { type: "string" },
        kid: { type: "string" },
        "dry-run": { type: "boolean" },
        "skip-existing": { type: "boolean" },
        help: { type: "boolean" },
      },
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
  const kid = values.kid ?? kidFor(now());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(kid)) {
    err(`--kid must look like YYYY-MM, got "${kid}"`);
    return 2;
  }
  let plan;
  try {
    plan = planSecrets(values.env, kid);
  } catch (e) {
    err(e.message);
    return 2;
  }

  if (values["dry-run"]) {
    out(`[dry-run] env=${values.env}: would create ${plan.names.length} secrets in Secrets Store (scope: workers):`);
    for (const n of plan.names) out(`  ${n}`);
    out(`[dry-run] active kid ${plan.activeKid}, standby kid ${plan.standbyKid}; no network calls made.`);
    return 0;
  }

  try {
    const cfg = await resolveCloudflareConfig(envVars, deps.fetch ?? fetch);
    const store = createSecretsStore({ fetch: deps.fetch ?? fetch, sleep: deps.sleep, ...cfg });
    const existing = await store.listNames();
    const present = plan.names.filter((n) => existing.has(n));
    if (present.length && !values["skip-existing"]) {
      err(`refusing to run: already in Secrets Store: ${present.join(", ")}\nNothing was written. Re-run with --skip-existing to upload only the missing names.`);
      return 1;
    }
    const [activeName, standbyName] = plan.names;
    const active = keygen();
    const standby = keygen();
    const comment = `PackServer key ceremony (${values.env})`;
    const uploads = [
      [activeName, active.privateValue],
      [standbyName, standby.privateValue],
      ...HMAC_SECRETS.map(([n]) => [`${plan.prefix}${n}`, newKey()]),
    ];
    const publicLine = new Map([
      [activeName, `active  kid=${plan.activeKid} public_key(raw, base64url)=${active.publicRaw}`],
      [standbyName, `standby kid=${plan.standbyKid} public_key(raw, base64url)=${standby.publicRaw}`],
    ]);
    // A public half is printed the moment its private half is stored, so a later failure
    // cannot leave a stored key whose public half was never shown.
    for (const [name, value] of uploads) {
      if (existing.has(name)) {
        out(`kept existing ${name}${publicLine.has(name) ? " (its public half is not recoverable from here)" : ""}`);
        continue;
      }
      await store.create(name, value, comment);
      out(`created ${name}`);
      if (publicLine.has(name)) out(`  ${publicLine.get(name)}`);
    }
    out("Bind only the active key to the validator; the standby stays bound to nothing.");
    return 0;
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
